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
including its open terminal streams. **Revoke all devices** also voids a pairing code that was shown but not used yet.
Sessions expire after 30 days; an expired device leaves the list.

**A paired device has the same control as you at the computer.** It can start agents (which run commands), type into
their terminals, change test commands and column actions, and approve steps. Pair only your own devices, and revoke any
you no longer use. A few things need someone at the computer and are refused from a phone: changing remote access, CLI
and GitHub sign-in (they open a browser or terminal there), native folder pickers, opening a project's folder, a terminal
or a code editor (Open in Finder, Open in IDE, and the list of editors): they open windows on the computer. A phone can
copy the path. Base imports are refused too: *Import MCP servers…* reads Claude Desktop's own configuration on the
computer, and *Import Markdown from a repository…* scans a repository there. GitHub, CLI and agent credentials are never
sent to the phone.

Everything else works from a phone because it runs on the computer exactly as it would from there, with the same
checks. That includes Compose's context sources: a local project folder (read-only, secret files skipped) and an MCP
connection test, which starts the configured local MCP program. They are not refused, for the same reason agents, test
commands and Base MCP connection tests are not: a paired device can already run programs and read project folders
through them, so refusing one more path would change nothing but the phone's usefulness.

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

**Turn off Tailscale Serve…** runs the matching `… off` command for the port Promptboard is served on. When another
Serve service uses the same address on another port, Settings warns: browsers send Promptboard's device cookie to every
port of a host name. If 443 and 8443 both already serve
other things, Promptboard changes nothing and asks you to choose a port yourself. Tailscale identity headers (`Tailscale-User-*`)
are not used for sign-in: the paired session decides.

## Twingate

Twingate reaches this computer through a Connector, so the Connector must be able to reach Promptboard's listener.
**Listen on this computer's private address** (Settings lists them, for example `192.168.1.20`): the local app never
listens there, so the Resource reaches only the paired listener. Public, wildcard and IPv6 addresses are refused.

`127.0.0.1` works only with a Connector installed directly on this computer, and is risky: a Resource that allows all
ports would then also reach Promptboard's local port (4318) without pairing. If you use it, limit the Resource to TCP
on the remote port only. A Connector in Docker or on another machine cannot reach `127.0.0.1` at all.

Then:

1. In Promptboard: **Settings → Remote access → Twingate**. Choose the listening address and port, and enter the name or
   address the phone will open (the Resource address, for example `promptboard.internal`). Save.
2. In the Twingate Admin Console, add a Resource for that address on a Connector that can reach this computer, limit it
   to TCP on the remote port, and give your account access. Promptboard does not change Twingate settings.
3. On the iPhone, connect the Twingate app, open the address and pair.

Twingate encrypts the phone-to-Connector path, but the last hop from the Connector to this computer is plain HTTP on
your network unless you give Promptboard a certificate and key (PEM files) for HTTPS. Settings warns until you do.

## Home Screen

In Safari, **Share → Add to Home Screen** opens Promptboard full screen. It is the same web app, without offline mode.

## What was verified

- Automated tests with simulated networks: the remote listener, pairing and rate limits, cookies, host and origin checks,
  proxy-header refusal on the local app, revocation (including open streams), restart, and the Tailscale CLI commands
  (a fake CLI). A route-table test sends every route the app serves from a paired device: the local-only ones are
  refused, every other one reaches the app, and a new route fails the test until it is classified.
- A real browser (Chrome with an iPhone-sized touch screen) pairing and using the app through the remote listener. On a
  touch screen every control is at least 44 px tall, and 44 px wide outside the top bar (at 390 px the top bar has no
  room for four 44 px icons beside the page links).
- WebKit, Safari's engine (Playwright, iPhone 15 profile): pairing, the board, every page fitting the screen, the
  HttpOnly SameSite=Strict cookie, reload, Settings on the phone, and revocation.
- The real Tailscale CLI on a Mac: status, the Serve command Promptboard runs, and a tailnet where Serve and HTTPS are
  not enabled yet (Settings shows Tailscale's enable link; nothing is changed).
- Not verified: Serve on a tailnet with HTTPS enabled, a real Twingate network, or a physical iPhone. Check those with
  your own devices before you rely on them.
