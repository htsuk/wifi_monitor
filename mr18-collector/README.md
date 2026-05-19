# MR18 Collector

POSIX shell script that runs as a `procd` service on OpenWrt, scanning both radios every 60 seconds and forwarding structured JSON to Splunk HEC.

---

## Files

| File | Destination on MR18 | Description |
|---|---|---|
| `wifi-monitor.sh` | `/usr/bin/wifi-monitor.sh` | Main collection and forwarding script |
| `wifi-monitor.init` | `/etc/init.d/wifi-monitor` | procd service definition |
| `config.example.json` | `/etc/wifi-monitor/config.json` | Configuration (copy and edit) |

---

## Dependencies

All dependencies are present in the OpenWrt base image — no `opkg install` required:

| Tool | Used for |
|---|---|
| `iw` | AP scanning and channel survey |
| `iwinfo` | Supplementary signal info |
| `awk` | Parsing `iw` output |
| `curl` | HEC POST |
| `jsonfilter` | Reading config.json |
| `logger` | Writing to syslog |

Optional: `python3` (`opkg install python3`) if you want to validate JSON output during development.

---

## Configuration reference

See `config.example.json` for a fully commented template. Key fields:

### `my_networks`

List of your own SSIDs. Any AP advertising one of these SSIDs will be classified as `classification=mine` in events. All others are `classification=neighbour`.

```json
"my_networks": [
  { "ssid": "MyMainNetwork", "band": "5GHz" },
  { "ssid": "MyIoTNetwork",  "band": "2.4GHz" },
  { "ssid": "MyGuestNetwork","band": "both" }
]
```

The `band` field is informational only — it doesn't restrict scanning, it's used to enrich events for your own reference.

### `my_bssid_prefixes`

Optional. List of OUI prefixes (first 3 octets) of your AP hardware. Provides an additional classification signal when an AP's SSID isn't in `my_networks` but its MAC OUI matches your equipment vendor.

```json
"my_bssid_prefixes": ["f4:2e:7f"]
```

### `splunk_hec_url`

Full URL including port and path:

```json
"splunk_hec_url": "https://splunk.example.com:8088/services/collector/event"
```

Self-signed certificates are handled with `curl -k`. If your HEC endpoint uses a valid cert, remove the `-k` flag from the script.

### `poll_interval_seconds`

Default 60. Reduce to 30 for higher resolution at the cost of slightly more CPU and HEC traffic. Not recommended below 30 — `iw scan` itself takes several seconds per radio.

### `radios`

Interface names for each band. Verify with `iw dev` on your device:

```json
"radios": {
  "2_4ghz": "wlan0",
  "5ghz": "wlan1"
}
```

---

## How channel utilisation is calculated

`iw dev survey dump` returns cumulative counters since the last reset:

- `channel active time` (ms) — total time the radio has been on this channel
- `channel busy time` (ms) — time the channel was detected as in use

The script stores the previous cycle's values in `/tmp/wifi-monitor-survey-prev.json` and calculates the delta:

```
utilisation_pct = (busy_delta / active_delta) * 100
```

On the first cycle after a reboot the previous values don't exist, so utilisation events are skipped for that cycle.

---

## Buffering and retry

If the HEC POST fails (Splunk unreachable, network down), events are written to `/tmp/wifi-monitor-buffer.json`. On the next successful cycle, buffered events are flushed before the new batch is sent.

The buffer is in `/tmp` (tmpfs) and is lost on reboot. This is intentional — flash write cycles on NAND devices are finite, and a gap in telemetry on reboot is preferable to premature flash wear.

---

## Service management

```sh
# Start
/etc/init.d/wifi-monitor start

# Stop
/etc/init.d/wifi-monitor stop

# Check status
/etc/init.d/wifi-monitor status

# View logs
logread | grep wifi-monitor

# Disable on boot
/etc/init.d/wifi-monitor disable
```

---

## Troubleshooting

**No events in Splunk after 90 seconds**

Check the logs:
```sh
logread | grep wifi-monitor | tail -20
```

Test the HEC endpoint manually from the MR18:
```sh
curl -k -H "Authorization: Splunk YOUR_TOKEN" \
  -d '{"event":"test"}' \
  http://YOUR_SPLUNK_IP:8088/services/collector/event
```

**`iw dev scan` returns nothing**

Confirm the interface is up:
```sh
ip link show wlan0
ip link set wlan0 up
iw dev wlan0 scan | head -20
```

**Only one band scanning**

Run `iw dev` and confirm both interfaces are listed. On some builds the 5GHz interface may be `wlan1` or `phy1-ap0` depending on OpenWrt version and board configuration.
