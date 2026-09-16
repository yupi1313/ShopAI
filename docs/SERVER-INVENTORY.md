# Server inventory — ubuntu-4gb-nbg1-1 (116.203.224.204)

Read-only snapshot taken 2026-09-16 13:08 server time over `ssh shopai`.
Nothing was changed, restarted or written on the box. This is the baseline
ShopAI must coexist with.

## Host

| Item | Value |
| --- | --- |
| Hetzner | CPX22, KVM vServer, Nuremberg |
| OS / kernel | Ubuntu 24.04.4 LTS, Linux 6.8.0-117-generic |
| Uptime | 112 days (built about late May 2026); **"System restart required"** flag is set (pending kernel update). Not ours to act on. |
| CPU / RAM | 2 vCPU; 3818 MB total, 1461 MB used, **2357 MB available**; 2 GB swapfile, 319 MB in use |
| Disk | `/dev/sda1` 75 GB, **68 GB used, 4.5 GB free (94 %)** |
| Docker | Engine 29.3.0, Compose v5.1.0. `docker system df`: images 5.8 GB, volumes 10.8 GB, **build cache 5.2 GB (3.3 GB reclaimable)** |
| Tools present | nginx, caddy, certbot, ufw (active), fail2ban, node + npm (no pnpm), python3, git. Not present: cloudflared, tailscale, psql, redis |
| SSH | root only, key auth. `authorized_keys` holds 3 keys: "claude-deploy" (this PC's `~/.ssh/ttplugin_deploy`), one `andrealispider@gmail.com`, one without comment. No `/home` users. |

## What runs here (all of it is "the neighbour")

| Workload | Where | How | Ports |
| --- | --- | --- | --- |
| **3x-ui** VPN panel (xray, hysteria, wireguard) | `/root/3x-ui` compose project `3x-ui`; `/etc/hysteria/port-hopping.sh` at reboot | Docker (host network) | `*:2053`, `*:2096`, `127.0.0.1:10443/11111/62789`, ufw opens 51820/udp, 54321/tcp, 443/udp; nginx site `vpn-panel` |
| **video** (cyclezilla video orchestrator + AceStream) | `/opt/video`, compose file `docker-compose.cyclezilla.yml`, project `video` | Docker, 2 containers, volumes `video_ace-1-cache` (large), `video_orchestrator-state` | `127.0.0.1:8098` (orchestrator), 6878 internal |
| **cyclezilla** (Python) | `/opt/cyclezilla` (venv), systemd `cyclezilla.service`, `cyclezilla-replay.service`, timers `cyclezilla-odds/-refresh/-latency` | systemd | `127.0.0.1:8099` (replay); nginx site `cyclezilla` on `8444` (ufw comment "cyclezilla https") |
| **bbbr-api** (FastAPI/uvicorn) | `/opt/bbbr` (venv), systemd `bbbr-api.service` | systemd | `127.0.0.1:8090`; nginx site `bbbr` |
| **nginx** (the reverse proxy) | `/etc/nginx/sites-enabled/{bbbr,cyclezilla,vpn-panel}` | systemd | **`0.0.0.0:80`, `:443`, `:8088`, `:8443`, `:8444`** |
| **caddy** | `/etc/caddy/Caddyfile` (112 bytes, effectively idle) | systemd | admin `127.0.0.1:2019` only |
| **pm2** (`pm2-root.service`) | `/root/.pm2`; runs `node packages/orchestrator/dist/index.js` | pm2 | none public |
| certbot timer, unattended-upgrades, fail2ban, sysstat | system | systemd timers | n/a |
| `/opt/loadtest` | leftover directory | n/a | n/a |

Memory users at snapshot: acestreamengine 263 MB, cyclezilla replay 258 MB,
node orchestrator 200 MB, journald 163 MB, pm2 127 MB, dockerd 87 MB.

## Change log: everything ShopAI has done on this box

Kept so the "neighbours untouched" claim is verifiable.

| When (UTC) | Change | Effect on neighbours |
| --- | --- | --- |
| 2026-09-16 13:11 | Created `/opt/shopai/cloudflared` (owner uid 65532); pulled image `cloudflare/cloudflared:latest` (~60 MB) | none |
| 2026-09-16 13:37 | Added `/opt/shopai/cf-login-loop.sh` + pid file; a `timeout 10800` bash loop runs `cloudflared tunnel login` containers until a cert arrives (self-terminates by 16:37) | none |
| 2026-09-16 14:05 | `docker builder prune -f` then `docker builder prune -af`, approved by the operator: reclaimed 3.32 GB + 1.84 GB of **build cache only**. Free disk 4.4 GB → 8.5 GB | none; all containers and systemd units verified active afterwards. Their next image rebuild will be slower once |

## Consequences for ShopAI

1. **Ports 80 and 443 belong to nginx.** We do not bind any public port.
   Telegram is long polling; the web page goes out through a Cloudflare
   Tunnel. This was the plan anyway and the inventory confirms it is the
   only clean option. No nginx or caddy config will be edited.
2. **Disk is the real constraint: 4.5 GB free.** Our images (Postgres,
   Node app, cloudflared) need roughly 1 GB; a Playwright Chromium adds
   about 0.5 GB; Postgres data and logs grow slowly. Building images **on
   the box** would push Docker's build cache further and risks filling the
   disk for every workload on it. Two safe options, to be chosen by you:
   - build images on the PC or GitHub Actions and pull them on the server
     (no build cache on the box), or
   - reclaim the 3.3 GB of reclaimable Docker **build cache** with
     `docker builder prune` (does not touch running containers, images in
     use, or volumes; the neighbour's next rebuild is just slower).
   Independently, the AceStream cache volume is the biggest consumer and is
   not ours to touch.
3. **RAM is fine:** about 2.3 GB available. Our stack at rest is about
   500 to 700 MB (Postgres 100 to 150, app 150 to 250, cloudflared 30);
   Playwright bursts add 400 to 500 MB and stay behind concurrency 1 and
   a 1 GB container limit.
4. **Docker networks:** we create our own `shopai` network; nothing joins
   `video_default` or the host network.
5. **ufw is active with default deny inbound.** We add no rules; nothing
   inbound is needed.
6. **Deploy user:** keep root for now (there are no other users on the box
   and Docker is root-managed); revisit after Phase 1.
7. **The pending reboot** is the operator's decision. ShopAI's compose
   stack will be `restart: unless-stopped`, so it survives one.
