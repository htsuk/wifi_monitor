# Architecture

## Overview

```
┌─────────────────────────────────────────────┐
│              Meraki MR18 (OpenWrt)           │
│                                              │
│  wlan0 (phy2 — QCA9558, 2.4GHz + 5GHz)      │
│  wlan1 (phy1 — PCI card, 5GHz, ch 36–140)   │
│                                              │
│  Every 60 seconds:                           │
│    iw dev wlan0 scan  ──▶ awk parser ──▶ ┐  │
│    iw dev wlan1 scan  ──▶ awk parser ──▶ ├──┼──▶ curl ──▶ Splunk HEC
│    iw dev survey dump ──▶ awk parser ──▶ ┘  │
│                                              │
│  /etc/wifi-monitor/config.json               │
│  /tmp/wifi-monitor-buffer.json  (retry buf)  │
│  /tmp/wifi-monitor-survey-prev.json (deltas) │
└─────────────────────────────────────────────┘
                    │
                    ▼ HTTPS / HEC
┌─────────────────────────────────────────────┐
│              Splunk Enterprise               │
│                                              │
│  index: wifi_monitor                         │
│  sourcetypes:                                │
│    wifi:ap_scan       (per AP per cycle)     │
│    wifi:channel_survey (per channel per rad) │
│                                              │
│  Dashboard Studio                            │
│    Overview           Channel Detail         │
│    My Networks        Neighbours             │
│                                              │
│  Custom viz: WiFi Spectrum (canvas 2D)       │
└─────────────────────────────────────────────┘
```

## Data flow

1. `wifi-monitor.sh` runs as a `procd` service — auto-restarts on crash, starts on boot
2. Each 60-second cycle runs `iw dev scan` on both radios concurrently
3. `awk` parsers emit newline-delimited Splunk HEC JSON directly — no intermediate files, no Python, no jq
4. Channel utilisation is calculated as a delta of cumulative `iw survey dump` counters between cycles
5. Each AP is classified as `mine` or `neighbour` by matching SSID against the `my_networks` list in `config.json`
6. Events are batched and POSTed to HEC in a single `curl` call per cycle
7. On HEC failure, events buffer to `/tmp` (tmpfs) and flush on the next successful cycle

## Hardware notes

The MR18 has two physically independent radio chips. This is what enables true simultaneous dual-band scanning — the two `iw scan` commands run concurrently without one radio having to time-share.

| Radio | Chip | Bands | Channels | Max TX |
|---|---|---|---|---|
| phy2 (wlan0) | QCA9558 (SoC) | 2.4GHz + 5GHz | 2.4: 1–13 / 5: 36–48 | 17 dBm |
| phy1 (wlan1) | Dedicated PCI | 5GHz only | 36–140 | 23 dBm |

For scanning purposes, `wlan0` covers 2.4GHz and lower 5GHz; `wlan1` covers the full 5GHz range with better sensitivity due to higher TX power and dedicated hardware.

## Resource usage

Observed on OpenWrt 25.12.4, kernel 6.12.87, 117MB RAM:

| Metric | Value |
|---|---|
| Idle RAM usage | ~44% (51MB) |
| Additional RAM (script running) | ~2–4MB |
| CPU load average (60s interval) | 0.25 / 0.07 / 0.02 |
| Flash writes | None (buffer in tmpfs only) |

## Scaling

A single MR18 covers one location. To monitor multiple locations or floors, deploy additional collectors with different `location_tag` values in `config.json` and use the `location` field as a filter in Splunk dashboards.
