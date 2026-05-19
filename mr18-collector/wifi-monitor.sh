
#!/bin/sh
# wifi-monitor.sh
# WiFi RF passive monitor: scans 2.4GHz + 5GHz, classifies APs, POSTs to Splunk HEC.
# Runs on OpenWrt 25.x (ash + awk + curl + jsonfilter). Requires: iw, curl, jsonfilter.

CONFIG="/etc/wifi-monitor/config.json"
TMPDIR="/tmp/wifi-monitor"
BATCH_FILE="$TMPDIR/batch.json"
BUFFER_FILE="$TMPDIR/buffer.json"
NOISE_FILE="$TMPDIR/noise.tsv"
SURVEY_PREV="$TMPDIR/survey-prev"

mkdir -p "$TMPDIR" "$SURVEY_PREV"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HEC_URL=$(jsonfilter -i "$CONFIG" -e '@.splunk_hec_url')
HEC_TOKEN=$(jsonfilter -i "$CONFIG" -e '@.splunk_hec_token')
HEC_INDEX=$(jsonfilter -i "$CONFIG" -e '@.splunk_index')
POLL_INTERVAL=$(jsonfilter -i "$CONFIG" -e '@.poll_interval_seconds')
LOCATION=$(jsonfilter -i "$CONFIG" -e '@.location_tag')
PHY_24=$(jsonfilter -i "$CONFIG" -e '@.radios["2_4ghz"].phy')
PHY_5=$(jsonfilter  -i "$CONFIG" -e '@.radios["5ghz"].phy')
IFACE_24=$(jsonfilter -i "$CONFIG" -e '@.radios["2_4ghz"].iface')
IFACE_5=$(jsonfilter  -i "$CONFIG" -e '@.radios["5ghz"].iface')
# Pipe-separated list of known SSIDs for classification (no paste on OpenWrt)
MY_SSIDS=$(jsonfilter -i "$CONFIG" -e '@.my_networks[*].ssid' | tr '\n' '|' | sed 's/|$//')
HOSTNAME=$(cat /proc/sys/kernel/hostname 2>/dev/null || echo "MR18-OpenWrt")

# ---------------------------------------------------------------------------
# Interface setup — managed mode, idempotent
# ---------------------------------------------------------------------------
setup_interface() {
    local phy="$1" iface="$2"
    if ip link show "$iface" >/dev/null 2>&1; then
        ip link set "$iface" up 2>/dev/null || true
        return 0
    fi
    iw phy "$phy" interface add "$iface" type managed 2>/dev/null || {
        logger -t wifi-monitor "ERROR: could not create $iface on $phy"
        return 1
    }
    ip link set "$iface" up
    logger -t wifi-monitor "Created $iface on $phy (managed)"
}

# ---------------------------------------------------------------------------
# Survey dump: build noise map and emit channel_survey HEC events
# ---------------------------------------------------------------------------
do_survey() {
    local iface="$1" band="$2" scan_id="$3" scan_time="$4"
    local raw_file="$TMPDIR/survey_raw_${iface}.tsv"
    local prev_file="$SURVEY_PREV/${iface}.tsv"

    # Parse survey dump → TSV: freq active_ms busy_ms noise_dbm
    # "Survey data from wlanX" separates channel blocks (no blank lines between)
    iw dev "$iface" survey dump 2>/dev/null | awk '
    BEGIN { freq=0; active=0; busy=0; noise=0 }
    function flush() {
        if (freq > 0) print freq "\t" active "\t" busy "\t" noise
        freq=0; active=0; busy=0; noise=0
    }
    /^Survey data/ { flush(); next }
    /frequency:/   && !/channel/ {
        f=$0; sub(/.*frequency:[[:space:]]+/, "", f); sub(/ MHz.*/, "", f); freq=int(f)
    }
    /noise:/               { n=$0; sub(/.*noise:[[:space:]]+/, "", n); sub(/ dBm.*/, "", n); noise=int(n) }
    /channel active time:/ { a=$0; sub(/.*time:[[:space:]]+/, "", a); sub(/ ms.*/, "", a); active=int(a) }
    /channel busy time:/   { b=$0; sub(/.*time:[[:space:]]+/, "", b); sub(/ ms.*/, "", b); busy=int(b) }
    END { flush() }
    ' > "$raw_file"

    # Append freq->noise pairs to noise map for scan event enrichment
    awk '{print $1 "\t" $4}' "$raw_file" >> "$NOISE_FILE"

    # Compute utilisation deltas, emit channel_survey HEC events
    awk -v iface="$iface" -v band="$band" -v scan_id="$scan_id" \
        -v scan_time="$scan_time" -v hostname="$HOSTNAME" \
        -v location="$LOCATION" -v hec_index="$HEC_INDEX" \
        -v prev_file="$prev_file" \
    '
    function json_str(s,    r) {
        r=s; gsub(/\\/, "\\\\", r); gsub(/"/, "\\\"", r)
        gsub(/\t/, "\\t", r); gsub(/\n/, "\\n", r); gsub(/\r/, "\\r", r)
        return "\"" r "\""
    }
    BEGIN {
        while ((getline line < prev_file) > 0) {
            split(line, a, "\t")
            prev_active[a[1]] = a[2]+0; prev_busy[a[1]] = a[3]+0
        }
        close(prev_file)
    }
    {
        freq=$1+0; active=$2+0; busy=$3+0; noise=$4+0
        if (freq > 0 && freq < 3000) { ch_band="2.4GHz"; channel=int((freq-2407)/5) }
        else                          { ch_band="5GHz";   channel=int((freq-5000)/5) }

        util = "null"
        if ((freq in prev_active) && prev_active[freq] > 0) {
            d_active = active - prev_active[freq]
            d_busy   = busy   - prev_busy[freq]
            if (d_active > 0) {
                u = (d_busy / d_active) * 100
                if (u < 0)   u = 0
                if (u > 100) u = 100
                util = sprintf("%.1f", u)
            }
        }
        e  = "{\"scan_id\":"            json_str(scan_id)
        e  = e ",\"collector_hostname\":" json_str(hostname)
        e  = e ",\"location\":"          json_str(location)
        e  = e ",\"radio\":"             json_str(iface)
        e  = e ",\"band\":"              json_str(ch_band)
        e  = e ",\"channel\":"           channel
        e  = e ",\"frequency_mhz\":"     freq
        e  = e ",\"active_time_ms\":"    active
        e  = e ",\"busy_time_ms\":"      busy
        e  = e ",\"utilisation_pct\":"   util
        e  = e ",\"noise_dbm\":"         noise
        e  = e "}"
        print "{\"time\":" scan_time ",\"source\":\"wifi-monitor\",\"sourcetype\":\"wifi:channel_survey\",\"index\":" json_str(hec_index) ",\"event\":" e "}"
    }
    ' "$raw_file" >> "$BATCH_FILE"

    # Persist current counters for next delta
    awk '{print $1 "\t" $2 "\t" $3}' "$raw_file" > "$prev_file"
}

# ---------------------------------------------------------------------------
# Scan: parse iw dev scan output, emit ap_scan HEC events
# ---------------------------------------------------------------------------
do_scan() {
    local iface="$1" band="$2" scan_id="$3" scan_time="$4"

    iw dev "$iface" scan 2>/dev/null | awk \
        -v radio="$iface" \
        -v scan_id="$scan_id" \
        -v scan_time="$scan_time" \
        -v hostname="$HOSTNAME" \
        -v location="$LOCATION" \
        -v hec_index="$HEC_INDEX" \
        -v my_ssids="$MY_SSIDS" \
        -v noise_file="$NOISE_FILE" \
    '
    function json_str(s,    r) {
        r=s; gsub(/\\/, "\\\\", r); gsub(/"/, "\\\"", r)
        gsub(/\t/, "\\t", r); gsub(/\n/, "\\n", r); gsub(/\r/, "\\r", r)
        return "\"" r "\""
    }

    BEGIN {
        FS = "\t"
        n = split(my_ssids, arr, "|")
        for (i=1; i<=n; i++) my_map[arr[i]] = 1
        while ((getline line < noise_file) > 0) {
            split(line, a, "\t"); noise_map[a[1]+0] = a[2]+0
        }
        close(noise_file)
        reset()
    }

    function reset() {
        bssid=""; ssid=""; freq=0; signal=0; last_seen=0; cap_privacy=0
        has_ht=0; has_vht=0; has_he=0; has_rsn=0; has_wpa=0
        ht_secondary="no secondary"; vht_op_width=-1
        in_ht_op=0; in_vht_op=0; ssid_found=0
    }

    function emit(    ch, bnd, std, width, is_hid, cls, enc, snr, noise_val, e) {
        if (bssid == "") return
        if      (freq > 0 && freq < 3000) { bnd="2.4GHz"; ch=int((freq-2407)/5) }
        else if (freq >= 5000)             { bnd="5GHz";   ch=int((freq-5000)/5) }
        else return

        if      (has_he)       std = "AX"
        else if (has_vht)      std = "AC"
        else if (has_ht)       std = "N"
        else if (freq >= 5000) std = "A"
        else                   std = "G"

        if      (vht_op_width == 2)              width = 160
        else if (vht_op_width == 1)              width = 80
        else if (ht_secondary != "no secondary") width = 40
        else                                     width = 20

        gsub(/\\x[0-9a-fA-F][0-9a-fA-F]/, "", ssid)
        is_hid = (ssid_found && ssid == "") ? "true" : "false"
        cls    = (ssid in my_map) ? "mine" : "neighbour"

        if      (has_rsn)     enc = "WPA2"
        else if (has_wpa)     enc = "WPA"
        else if (cap_privacy) enc = "WEP"
        else                  enc = "open"

        freq_key = int(freq)
        noise_val = (freq_key in noise_map) ? noise_map[freq_key] : "null"
        if (noise_val != "null" && signal != 0)
            snr = signal - noise_val
        else
            snr = "null"

        e  = "{\"scan_id\":"             json_str(scan_id)
        e  = e ",\"collector_hostname\":" json_str(hostname)
        e  = e ",\"location\":"           json_str(location)
        e  = e ",\"radio\":"              json_str(radio)
        e  = e ",\"band\":"               json_str(bnd)
        e  = e ",\"bssid\":"              json_str(bssid)
        e  = e ",\"ssid\":"               json_str(ssid)
        e  = e ",\"channel\":"            ch
        e  = e ",\"channel_width_mhz\":"  width
        e  = e ",\"frequency_mhz\":"      freq_key
        e  = e ",\"signal_dbm\":"         signal
        e  = e ",\"noise_dbm\":"          noise_val
        e  = e ",\"snr_db\":"             snr
        e  = e ",\"standard\":"           json_str(std)
        e  = e ",\"encryption\":"         json_str(enc)
        e  = e ",\"classification\":"     json_str(cls)
        e  = e ",\"is_hidden\":"          is_hid
        e  = e ",\"last_seen_ms\":"       last_seen
        e  = e "}"
        print "{\"time\":" scan_time ",\"source\":\"wifi-monitor\",\"sourcetype\":\"wifi:ap_scan\",\"index\":" json_str(hec_index) ",\"event\":" e "}"
    }

    # BSS lines have no leading tab — match with regex, not field comparison
    /^BSS / {
        emit(); reset()
        bssid = $0; sub(/^BSS /, "", bssid); sub(/\(.*/, "", bssid)
        next
    }

    # Single-tab fields: $1=="" (empty before tab), $2="key: value"
    $1 == "" && $2 ~ /^freq: / {
        freq = $2; sub(/^freq: /, "", freq); freq = int(freq+0); next
    }
    $1 == "" && $2 ~ /^signal: / {
        signal = $2; sub(/^signal: /, "", signal); sub(/ dBm.*/, "", signal); signal = int(signal+0); next
    }
    $1 == "" && $2 ~ /^SSID: ?/ {
        ssid_found=1; ssid=$2; sub(/^SSID: ?/, "", ssid); next
    }
    $1 == "" && $2 == "SSID:" {
        ssid_found=1; ssid=""; next
    }
    $1 == "" && $2 ~ /^last seen: / {
        last_seen=$2; sub(/^last seen: /, "", last_seen); sub(/ ms.*/, "", last_seen); last_seen=int(last_seen); next
    }
    $1 == "" && $2 ~ /^capability: / {
        if ($2 ~ /Privacy/) cap_privacy=1; next
    }

    # Single-tab capitalised section headers — reset context, detect key sections
    $1 == "" && $2 ~ /^[A-Z]/ {
        in_ht_op=0; in_vht_op=0
        if      ($2 == "HT capabilities:")        has_ht=1
        else if ($2 == "VHT capabilities:")        has_vht=1
        else if ($2 ~ /^HE [Cc]apabilit/)          has_he=1
        else if ($2 == "HT operation:")            in_ht_op=1
        else if ($2 == "VHT operation:")           in_vht_op=1
        else if ($2 ~ /^RSN:/)                      has_rsn=1
        else if ($2 ~ /^WPA:/)                      has_wpa=1
        next
    }

    # Double-tab fields: $1=="" $2=="" $3=" * key: ..."
    $1 == "" && $2 == "" && in_ht_op && $3 ~ /secondary channel offset:/ {
        if      ($3 ~ /above/) ht_secondary="above"
        else if ($3 ~ /below/) ht_secondary="below"
        else                   ht_secondary="no secondary"
        next
    }
    $1 == "" && $2 == "" && in_vht_op && $3 ~ /channel width:/ {
        line=$3; sub(/.* channel width: /, "", line); vht_op_width=int(line); next
    }

    END { emit() }
    ' >> "$BATCH_FILE"
}

# ---------------------------------------------------------------------------
# HEC POST with buffer retry
# ---------------------------------------------------------------------------
send_to_splunk() {
    local file="$1"
    [ -s "$file" ] || return 0

    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: Splunk ${HEC_TOKEN}" \
        -H "Content-Type: application/json" \
        --data-binary @"$file" \
        --insecure \
        --max-time 10 \
        "${HEC_URL}" 2>/dev/null)

    if [ "$http_code" = "200" ]; then
        logger -t wifi-monitor "HEC OK ($(wc -l < "$file" | tr -d ' ') events)"
        return 0
    else
        logger -t wifi-monitor "HEC failed (HTTP ${http_code:-000}), buffering"
        # Never append buffer to itself — cat file >> file grows exponentially and fills tmpfs.
        # Also cap buffer at 200KB to keep curl memory usage bounded.
        if [ "$file" = "$BUFFER_FILE" ]; then
            > "$BUFFER_FILE"
        else
            local buf_size
            buf_size=0
            [ -s "$BUFFER_FILE" ] && buf_size=$(wc -c < "$BUFFER_FILE")
            if [ "$buf_size" -lt 204800 ]; then
                cat "$file" >> "$BUFFER_FILE"
            else
                logger -t wifi-monitor "Buffer cap exceeded (${buf_size}B), discarding"
                > "$BUFFER_FILE"
            fi
        fi
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
setup_interface "$PHY_24" "$IFACE_24" || exit 1
setup_interface "$PHY_5"  "$IFACE_5"  || exit 1

logger -t wifi-monitor "Started (2.4GHz=$IFACE_24/$PHY_24  5GHz=$IFACE_5/$PHY_5  interval=${POLL_INTERVAL}s)"

while true; do
    SCAN_TIME=$(date +%s)
    SCAN_ID="$SCAN_TIME"

    # Re-create interfaces if they've disappeared (e.g. driver reset mid-run)
    if ! ip link show "$IFACE_24" >/dev/null 2>&1 || ! ip link show "$IFACE_5" >/dev/null 2>&1; then
        logger -t wifi-monitor "Interfaces missing, recreating"
        setup_interface "$PHY_24" "$IFACE_24"
        setup_interface "$PHY_5"  "$IFACE_5"
    fi

    > "$BATCH_FILE"
    > "$NOISE_FILE"

    # Flush buffered events from previous failures
    if [ -s "$BUFFER_FILE" ]; then
        if send_to_splunk "$BUFFER_FILE"; then
            rm -f "$BUFFER_FILE"
        fi
    fi

    # Survey first (populates noise map used by scan events)
    do_survey "$IFACE_24" "2.4GHz" "$SCAN_ID" "$SCAN_TIME"
    do_survey "$IFACE_5"  "5GHz"   "$SCAN_ID" "$SCAN_TIME"

    # Scan both radios
    do_scan "$IFACE_24" "2.4GHz" "$SCAN_ID" "$SCAN_TIME"
    do_scan "$IFACE_5"  "5GHz"   "$SCAN_ID" "$SCAN_TIME"

    AP_COUNT=$(grep -c '"sourcetype":"wifi:ap_scan"' "$BATCH_FILE" 2>/dev/null) || AP_COUNT=0
    logger -t wifi-monitor "Cycle $SCAN_ID: $AP_COUNT APs across 2 radios"
    send_to_splunk "$BATCH_FILE"

    sleep "$POLL_INTERVAL"
done
