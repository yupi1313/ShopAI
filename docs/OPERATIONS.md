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

The assistant's PC holds a dedicated key pair `~/.ssh/shopai_ed25519`
(created 2026-09-16). Its public half:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDTRSUu5f+IlGIXnuOABshdaTPMvI6ct58Ei1cud32sZ shopai-deploy@q1qooo
```

Log in to `116.203.224.204` as `root` yourself (your own key or the Hetzner
web console) and append it:

```bash
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDTRSUu5f+IlGIXnuOABshdaTPMvI6ct58Ei1cud32sZ shopai-deploy@q1qooo' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
```

Adding the key in the Hetzner Cloud console under *Security → SSH keys*
does **not** install it on an existing server; it only applies to servers
created afterwards. The append above is what works.

Root is used for the read-only recon because the inventory must see the
neighbour project's containers, units and ports. After recon we decide
whether day-to-day deploys move to a dedicated `shopai` user in the
`docker` group.

Verification from the PC:

```bash
ssh -i ~/.ssh/shopai_ed25519 -o IdentitiesOnly=yes root@116.203.224.204 'hostname; uptime'
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

### 1.3 Telegram bot in BotFather

1. Open `@BotFather` → `/newbot` → display name `ShopAI` → a username
   ending in `bot`, e.g. `chern_shopai_bot`. Keep the token for
   `/opt/shopai/.env` as `TELEGRAM_BOT_TOKEN`.
2. `/setprivacy` → choose the bot → **Disable**. This is required: with
   privacy mode on, Telegram delivers only commands and @mentions to a bot
   in a group, so nicknames like `шон, добавь молоко` would never reach it.
3. `/setjoingroups` → **Enable**. Then add the bot to the family group.
4. `/setcommands` is done by the app itself on boot.
5. Family Telegram user ids: each member sends `/start` to the bot once the
   app runs; unknown ids are logged and an admin approves them with
   `/members add <id>`. Your own id is put in `.env` as `ADMIN_TELEGRAM_ID`
   so the first admin exists before anyone is approved. `@userinfobot`
   shows an id if you want them in advance.

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
