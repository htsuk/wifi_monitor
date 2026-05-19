# Splunk WiFi Monitor

Passive WiFi RF monitoring pipeline running on a repurposed Meraki MR18 access point, forwarding structured telemetry to Splunk for real-time dashboarding and spectrum visualisation.

> **Article:** [Building a £0 WiFi Intelligence Stack with a Rescued Meraki AP and Splunk](https://thesplunkstack.substack.com) — The Splunk Stack

---

## What it does

- Scans both 2.4GHz and 5GHz bands simultaneously every 60 seconds using the MR18's two independent radios
- Collects per-AP data: BSSID, SSID, channel, channel width, signal (dBm), SNR, 802.11 standard, encryption
- Collects per-channel data: utilisation %, noise floor (dBm)
- Classifies every observed AP as `mine` or `neighbour` based on a configurable SSID list
- Forwards structured JSON events to Splunk HEC
- Provides a four-tab Splunk Dashboard Studio dashboard including a custom RF spectrum visualisation

---

## Repository structure

```
wireless-monitor/
├── README.md                          ← you are here
├── mr18-collector/
│   ├── README.md                      ← collector deployment guide
│   ├── wifi-monitor.sh                ← main collection and forwarding script
│   ├── wifi-monitor.init              ← procd service script (/etc/init.d/)
│   └── config.example.json            ← configuration template
├── splunk-app/
│   └── wifi_monitor/
│       ├── default/
│       │   └── dashboards/
│       │       ├── overview.xml
│       │       ├── channel_detail.xml
│       │       ├── my_networks.xml
│       │       └── neighbours.xml
│       └── appserver/
│           └── static/
│               └── visualizations/
│                   └── wifi_spectrum/ ← custom canvas spectrum viz
└── docs/
    ├── architecture.md
    └── screenshots/
```

---

## Prerequisites

### Hardware

- Meraki MR18 (or compatible OpenWrt device with dual-band radios)
- OpenWrt 19.07 or later (tested on 25.12.4, kernel 6.12.87)
- PoE switch port or PoE injector

The MR18 is regularly available on eBay for under £20. It has two independent radio chips (QCA9558 onboard SoC + dedicated PCI card) enabling true simultaneous 2.4GHz and 5GHz scanning from a single device.

### Splunk

- Splunk Enterprise or Splunk Cloud
- HTTP Event Collector (HEC) enabled
- Dashboard Studio (available in Splunk 8.x+)

---

## Quick start

### 1. Prepare the MR18

Flash OpenWrt if not already done. See the [OpenWrt MR18 device page](https://openwrt.org/toh/meraki/mr18) for instructions — initial flash requires UART serial access.

Verify both radios are present:

```sh
iw dev
```

You should see two interfaces (e.g. `wlan0` and `wlan1`). Note the interface names — they go into `config.json`.

### 2. Configure

Copy `mr18-collector/config.example.json` to `/etc/wifi-monitor/config.json` on the MR18 and edit it:

```sh
mkdir -p /etc/wifi-monitor
scp mr18-collector/config.example.json root@<MR18-IP>:/etc/wifi-monitor/config.json
ssh root@<MR18-IP> vi /etc/wifi-monitor/config.json
```

At minimum, set:
- `my_networks` — your own SSID names
- `splunk_hec_url` — your HEC endpoint
- `splunk_hec_token` — your HEC token

### 3. Deploy the collector

```sh
scp mr18-collector/wifi-monitor.sh root@<MR18-IP>:/usr/bin/wifi-monitor.sh
ssh root@<MR18-IP> chmod +x /usr/bin/wifi-monitor.sh

scp mr18-collector/wifi-monitor.init root@<MR18-IP>:/etc/init.d/wifi-monitor
ssh root@<MR18-IP> chmod +x /etc/init.d/wifi-monitor
ssh root@<MR18-IP> /etc/init.d/wifi-monitor enable
ssh root@<MR18-IP> /etc/init.d/wifi-monitor start
```

### 4. Verify events in Splunk

```spl
index=wifi_monitor | head 5
```

You should see `wifi:ap_scan` and `wifi:channel_survey` events within 60–90 seconds.

![alt text](https://github.com/htsuk/wifi_monitor/blob/main/docs/screenshots/Screenshot%202026-05-19%20at%2022.34.50.png) "Logo Title Text 1")

### 5. Install the Splunk app

Copy `splunk-app/wifi_monitor/` to `$SPLUNK_HOME/etc/apps/` on your Splunk instance and restart, or install via the Splunk UI (Apps → Manage Apps → Install from file).

---

## Event schema

### `wifi:ap_scan`

One event per visible access point per scan cycle.

| Field | Type | Description |
|---|---|---|
| `bssid` | string | MAC address of the AP |
| `ssid` | string | Network name (empty if hidden) |
| `is_hidden` | bool | True if SSID is not broadcast |
| `band` | string | `2.4GHz` or `5GHz` |
| `channel` | int | Primary channel number |
| `channel_width_mhz` | int | 20 / 40 / 80 / 160 |
| `frequency_mhz` | int | Centre frequency |
| `signal_dbm` | int | RSSI at the collector antenna |
| `snr_db` | int | Signal-to-noise ratio |
| `standard` | string | AX / AC / N / A / G |
| `encryption` | string | WPA2 / WPA / WEP / open |
| `classification` | string | `mine` or `neighbour` |
| `radio` | string | Interface name (e.g. `wlan1`) |
| `collector_hostname` | string | Hostname of the MR18 |
| `location` | string | Configurable location tag |
| `scan_id` | string | Unique ID shared across all events in one cycle |

### `wifi:channel_survey`

One event per observed channel per radio per scan cycle.

| Field | Type | Description |
|---|---|---|
| `radio` | string | Interface name |
| `band` | string | `2.4GHz` or `5GHz` |
| `channel` | int | Channel number |
| `frequency_mhz` | int | Channel centre frequency |
| `utilisation_pct` | float | `busy_time / active_time * 100` (delta between cycles) |
| `noise_dbm` | int | Noise floor |

---

## Licence

MIT. See [LICENSE](LICENSE).

---

## Author

Nick Hills — [The Splunk Stack](https://thesplunkstack.substack.com) | [LinkedIn](https://www.linkedin.com/in/nickhills) | [GitHub](https://github.com/htsuk)
