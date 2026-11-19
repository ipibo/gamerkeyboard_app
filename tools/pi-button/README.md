# Shutdown button (Pi 5)

Hold button 2 s → player gets SIGTERM (sends black frame on all 4 buses) →
server `/api/player/stop` sends one more blackout → `sync` → `systemctl poweroff`.

## 1. Check pins on the Pi

```bash
grep -E '^(dtoverlay|dtparam)' /boot/firmware/config.txt
ls /dev/spidev*
pinctrl get 0-27
```

Expected SPI pin use (each overlay also claims MISO + CE, even though only MOSI/SCLK are wired):

| Bus | Device | Overlay | GPIOs (CE0, MISO, MOSI, SCLK) |
|---|---|---|---|
| 0 | /dev/spidev0.0 | spi0 | 8, 9, 10, 11 (+7 if CE1) |
| 1 | /dev/spidev3.0 | spi3 | 0, 1, 2, 3 |
| 2 | /dev/spidev4.0 | spi4 | 4, 5, 6, 7 |
| 3 | /dev/spidev6.0 | spi6 | 18, 19, 20, 21 |

Free: GPIO 12, 13, 16, 17, 22, 23, 24, 25, 26, 27 (avoid 14/15 = UART).
Default: **GPIO17 = header pin 11**, GND = **pin 9** (right next to it).
If `pinctrl` shows GPIO17 in use, pick another free one and change `BUTTON_GPIO`.

## 2. Wire

Button between pin 11 (GPIO17) and pin 9 (GND). No resistor: internal pull-up.

## 3. Install (from Mac)

```bash
scp tools/pi-button/shutdown_button.py tools/pi-button/shutdown-button.service <user>@keyboard.local:/tmp/
```

On the Pi:

```bash
sudo install -m 755 /tmp/shutdown_button.py /usr/local/bin/keyboard-shutdown-button.py
sudo install -m 644 /tmp/shutdown-button.service /etc/systemd/system/shutdown-button.service
python3 -c "import gpiozero, lgpio" || sudo apt install -y python3-gpiozero python3-lgpio
```

## 4. Test without shutting down

```bash
sudo python3 /usr/local/bin/keyboard-shutdown-button.py --dry-run
```

Hold button 2 s → log shows `DRY RUN: would stop player...`. Ctrl+C.

## 5. Enable

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now shutdown-button
journalctl -u shutdown-button -f
```

## Notes

- After poweroff, Pi 5 stays in halt (red LED). Restart: Pi 5 onboard power button, or cut + restore power.
- LED PSU stays on; LEDs keep last latched data = black.
- If something auto-restarts the player (pm2, systemd `Restart=always`), it can race the shutdown. Check `pm2 list`, `systemctl list-units --type=service | grep -i player`.
