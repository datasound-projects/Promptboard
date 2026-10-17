# Remote access from an iPhone

Use Promptboard from your iPhone (Safari) while everything keeps running on your computer: agents, CLIs, Git, files
and credentials never leave it. Remote access is **off by default**; the local app on `127.0.0.1` is unchanged either
way.

There are two private networks to choose from:

- **Tailscale** (recommended): Tailscale Serve gives the phone an HTTPS address inside your tailnet.
- **Twingate**: a Twingate Resource points at this computer through one of your Connectors.

Promptboard never exposes itself to the public internet. It never turns on Tailscale Funnel, and refuses any request
that Tailscale marks as coming through Funnel.

## How it works

Turning remote access on starts a second listener (port 4319 by default) beside the local app. Every request on it
must come from a **paired device**:

1. On the computer: **Settings → Remote access (iPhone) → Pair a device** shows a one-time code (8 characters, valid
   10 minutes, usable once).
2. On the phone: open the private address and enter the code. The phone gets an HttpOnly, SameSite=Strict session
   cookie (Secure over HTTPS). Promptboard stores only a hash of it.
3. The phone then uses the same app, with the same checks as on the computer: the session token, origin checks,
   Content-Security-Policy and every approval gate.

Paired devices are listed in Settings with when they were paired and last seen. **Revoke** ends a device at once,
including its open terminal streams. Sessions expire after 30 days.

Some things stay on the computer and are refused from a phone: changing remote access, CLI and GitHub sign-in, native
folder pickers, and testing local MCP programs. GitHub, CLI and agent credentials are never sent to the phone.

### When the phone sleeps

Closing Safari, locking the phone or losing the VPN connection stops nothing. Kanban runs, Autopilot, Compose Batch
and Research chats started from the phone keep running on the computer, and the phone shows their current state when
it reconnects. The server is the authority: a second click while a run is going never starts a duplicate.

A single Compose generation (not Batch) is tied to the page that asked for it. If that page goes away, the generation
is cancelled so no usage is spent on a result nobody receives. Use Compose Batch for work that must finish on its own.

## Tailscale

1. Install Tailscale on the computer and the iPhone, sign both into the same tailnet, and connect them.
2. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates** (DNS page).
3. In Promptboard: **Settings → Remote access → Tailscale (recommended) → Save**.
4. Choose **Turn on Tailscale Serve…** and confirm. Promptboard runs exactly the command it shows, for example
   `tailscale serve --bg --https=443 http://127.0.0.1:4319`. If another service already uses 443, it uses 8443 and
   changes nothing else. You can also run the command yourself. If the command asks for confirmation or HTTPS
   certificates, run it once in a terminal and follow its instructions.
5. Promptboard shows the address Tailscale reports (`https://<computer>.<tailnet>.ts.net`). It never builds this
   address itself. **Copy URL**, open it in Safari on the iPhone, and pair.

**Turn off Tailscale Serve…** runs the matching `… off` command for that port. If 443 and 8443 both already serve
other things, Promptboard changes nothing and asks you to choose a port yourself. Tailscale identity headers (`Tailscale-User-*`)
are not used for sign-in: the paired session decides.

## Twingate

Twingate reaches this computer through a Connector, so the Connector must be able to reach Promptboard's listener:

- **Connector on this computer (installed natively):** listen on `127.0.0.1`.
- **Connector in Docker or on another machine:** it cannot reach this computer's `127.0.0.1`. Listen on this computer's
  private address (Settings lists them, for example `192.168.1.20`). Public and wildcard addresses are refused.

Then:

1. In Promptboard: **Settings → Remote access → Twingate**. Choose the listening address and port, and enter the name or
   address the phone will open (the Resource address, for example `promptboard.internal`). Save.
2. In the Twingate Admin Console, add a Resource for that address and port on a Connector that can reach this computer,
   and give your account access. Promptboard does not change Twingate settings.
3. On the iPhone, connect the Twingate app, open the address and pair.

Twingate encrypts the phone-to-Connector path, but the last hop from the Connector to this computer is plain HTTP on
your network unless you give Promptboard a certificate and key (PEM files) for HTTPS. Settings warns until you do.

## Home Screen

In Safari, **Share → Add to Home Screen** opens Promptboard full screen. It is the same web app, without offline mode.

## What was verified

- Automated tests with simulated networks: the remote listener, pairing and rate limits, cookies, host and origin checks,
  proxy-header refusal on the local app, local-only routes, revocation (including open streams), restart, and the
  Tailscale CLI commands (a fake CLI).
- A real browser (Chrome with an iPhone-sized touch screen) pairing and using the app through the remote listener.
- Not verified by these tests: a real tailnet, a real Twingate network, Safari/WebKit, or a physical iPhone. Check those
  with your own devices before you rely on them.
