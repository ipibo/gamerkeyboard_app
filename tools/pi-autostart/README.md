# Autostart on boot (Pi 5)

- `rgbkeyboard-server.service` — runs `node server.js` as user `keyboard` in `/home/keyboard/gamerkeyboard_app`.
- `rgbkeyboard-player.service` — after the server is up, `start-player-on-boot.sh` calls `POST /api/player/start`.
  - `BOOT_BRIGHTNESS` (1..31, default 1)
  - `BOOT_ENTRY_ID` (library entry id; empty = `output/videoFile_bus*.txt`)

## Install

From Mac (repo root):

```bash
scp -r tools/pi-button tools/pi-autostart keyboard@keyboard.local:~/gamerkeyboard_app/tools/
```

On the Pi:

```bash
chmod +x ~/gamerkeyboard_app/tools/pi-autostart/start-player-on-boot.sh
sudo cp ~/gamerkeyboard_app/tools/pi-autostart/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rgbkeyboard-server rgbkeyboard-player
```

## Check

```bash
systemctl status rgbkeyboard-server rgbkeyboard-player --no-pager
journalctl -u rgbkeyboard-player -b --no-pager
```

Change brightness: edit `/etc/systemd/system/rgbkeyboard-player.service`, then `sudo systemctl daemon-reload`.
