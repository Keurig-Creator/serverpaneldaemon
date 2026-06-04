# Server Panel Daemon

Backend service for managing Java containers and server processes.

## Requirements

Ubuntu 26.04
Docker
Docker Compose

## Installation

Clone the repo to /srv/Daemon:

```bash
sudo mkdir -p /srv
cd /srv
sudo git clone https://git.keurigsweb.com/david/daemon Daemon
sudo chown -R www-data:www-data Daemon
```

## Setup Environment

Copy .env.example to .env:

```bash
cd /srv/Daemon
cp .env.example .env
```

Edit .env with your settings:

```
PORT=8080
```

## Systemd Service

Create /etc/systemd/system/daemon.service:

```bash
sudo nano /etc/systemd/system/daemon.service
```

Paste this content:

```ini
[Unit]
Description=Server Panel Daemon service
After=network.target docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/srv/Daemon
User=www-data
Group=www-data
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

## Enable and Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable daemon.service
sudo systemctl start daemon.service
```

## Access

API available at http://localhost:8080 or your server IP:8080

## Service Management

Check status:
```bash
sudo systemctl status daemon.service
```

View logs:
```bash
sudo journalctl -u daemon.service -f
```

Stop service:
```bash
sudo systemctl stop daemon.service
```

Restart service:
```bash
sudo systemctl restart daemon.service
```

## Development

Run locally without systemd:

```bash
cd /srv/Daemon
docker compose up
```

Rebuild containers:

```bash
docker compose down
docker compose up -d
```

## Troubleshooting

Port 8080 in use:
```bash
sudo lsof -i :8080
```

Docker not running:
```bash
sudo systemctl status docker
```

Permission denied:
```bash
sudo chown -R www-data:www-data /srv/Daemon
```

Service won't start:
```bash
sudo journalctl -u daemon.service -n 50
```