# ShopAI operations

Runbook for the things a human has to do by hand. Architecture and
rationale are in [ARCHITECTURE.md](./ARCHITECTURE.md).

**Secrets rule.** Tokens and passwords go straight into `/opt/shopai/.env`
on the server (owner root, mode 600), typed or pasted by you. They are
never pasted into a chat with the assistant, never committed, never put in
a URL.

---

## 1. Before Phase 0: three things only you can do

### 1.1 Authorise the deployment SSH key on the box

**State on 2026-09-16.** The Hetzner project lists the key `lucky-deploy`
(MD5 `44:e1:80:cf:f2:d1:fc:49:f8:15:d3:41:44:de:27:b8`). Its private half
on the PC is `~/.ssh/lucky_hetzner`; the fingerprint matches exactly. The
server `116.203.224.204` still answers `Permission denied (publickey)` for
`root` with it, so the key is registered in Hetzner but **was never
installed on this server**. Hetzner only installs the keys chosen at
server creation; keys added to the project later, and "Rebuild", do not
touch an existing server's `authorized_keys`.

The PC's `~/.ssh/config` has an alias for the box:

```
Host shopai
  HostName 116.203.224.204
  User root
  IdentityFile ~/.ssh/lucky_hetzner
  IdentitiesOnly yes
```

**Fix (no reboot, neighbour untouched):** open a root shell on the server
by any route that already works for you: the Hetzner Cloud console (the
`>_` icon on the server page, log in as root with the root password), or
`ssh root@116.203.224.204` with the password from your own terminal. Then
paste:

```bash
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOSojalu12/r6KFXXR2ZVmwJDOzQ0YJFMtTvDMR8NKxD lucky-deploy' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
```

Do **not** use Hetzner Rescue mode for this: it reboots the server and
takes the other project down.

Alternative key, if you prefer a ShopAI-only one: the PC also holds
`~/.ssh/shopai_ed25519`; append this line instead and change
`IdentityFile` in the alias accordingly:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDTRSUu5f+IlGIXnuOABshdaTPMvI6ct58Ei1cud32sZ shopai-deploy@q1qooo
```

Root is used for the read-only recon because the inventory must see the
neighbour project's containers, units and ports. After recon we decide
whether day-to-day deploys move to a dedicated `shopai` user in the
`docker` group.

Verification from the PC:

```bash
ssh shopai 'hostname; uptime'
```

### 1.2 Cloudflare Tunnel for the web page

`chern.nl` is registered at Porkbun, but its nameservers are Cloudflare's
(`ignat.ns.cloudflare.com`, `tia.ns.cloudflare.com`). **All DNS records for
chern.nl are therefore managed in the Cloudflare dashboard; nothing needs to
change at Porkbun.**

With a tunnel there is no DNS record to add by hand either; Cloudflare
creates the CNAME when you add the public hostname.

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** →
   **Create a tunnel** → connector type **Cloudflared** → name `shopai`.
2. On the "Install connector" step, copy the **tunnel token** (the long
   string after `--token` in the shown command). You will paste it later
   into `/opt/shopai/.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Do not send it to
   the assistant.
3. **Public Hostname** tab → **Add a public hostname**:
   subdomain `shop`, domain `chern.nl`, type `HTTP`, URL `server:3000`.
   Save. Cloudflare adds `shop.chern.nl CNAME <tunnel-id>.cfargotunnel.com`
   (proxied) to the zone automatically.
4. Optional second lock: **Zero Trust → Access → Applications → Add** →
   self-hosted, domain `shop.chern.nl`, policy *Allow* with the family's
   e-mail addresses. The app's own magic-link login still applies behind it.

Until the server side exists the hostname will show a Cloudflare 1033
error, which is expected.

If you prefer a different name than `shop.chern.nl`, use it in step 3 and
tell the assistant; nothing else changes.

**Fallback without a tunnel** (only if ports 80/443 turn out to be free on
the box and you would rather not use a tunnel): in Cloudflare DNS add
`A shop 116.203.224.204` and `AAAA shop <server IPv6>` and the stack runs
its own Caddy. Decided after recon.

### 1.3 Telegram bot — done

The bot exists: **@CheShopBot** (bot id `8690959586`), created
2026-09-16. Verified with `getMe`: `can_join_groups: true` and
`can_read_all_group_messages: true`, so **privacy mode is already off** and
nickname triggers in groups will work. No webhook is set; the app uses long
polling.

- The token is stored in the PC's local `D:\AI\ShopAI\.env` (gitignored,
  never committed) and must be copied into `/opt/shopai/.env` as
  `TELEGRAM_BOT_TOKEN` when the server stack is created.
- If the token ever needs rotating: `@BotFather` → `/revoke` → pick the
  bot, then update both `.env` files.
- Add the bot to the family group once the app runs. `/setcommands` is done
  by the app itself on boot.
- Family Telegram user ids: each member sends `/start` to the bot; unknown
  ids are logged and an admin approves them with `/members add <id>`. Your
  own id goes into `.env` as `ADMIN_TELEGRAM_ID` so the first admin exists
  before anyone is approved. `@userinfobot` shows an id if you want them in
  advance.

---

## 2. Repository

- Remote: `https://github.com/yupi1313/ShopAI` (private).
- Commits from the PC use the repo-local identity `yupi1313` with the
  GitHub noreply address; pushes use the `gh` credential helper with
  `yupi1313` as the active `gh` account. Global Git settings were not
  changed.

---

## 3. Server layout (planned, applied in Phase 1)

```
/opt/shopai/
  docker-compose.yml
  .env                 root:root 600; all secrets
  data/postgres/       Postgres volume
  backups/             nightly pg_dump, keep 14
  profiles/            Playwright browser profiles (marketplace connectors)
```

Services: `postgres` (no ports), `server` (no ports), `cloudflared` (no
ports, outbound tunnel). Own docker network `shopai`. Nothing of the
neighbour project is read, written, restarted or re-proxied.

The recon inventory is recorded in `SERVER-INVENTORY.md` before any of
this is created.
