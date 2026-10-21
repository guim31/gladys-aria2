# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secret**: the aria2 RPC secret (`--rpc-secret`), stored by Gladys in the
  integration configuration. It is sent only to the configured aria2 address,
  inside the JSON-RPC body, and never written to the logs, the device
  parameters or the connection status. An address with credentials in it
  (`http://user:pass@…`) is refused.
- **Nothing is written** under `/data`: the integration keeps no state on
  disk.
- **Network**: HTTP(S) and WebSocket requests to the configured aria2 address
  only (the local network in the usual case). No cloud service.
- **Commands**: pause, resume, the global download limit, and adding a link
  from a scene (http, https, ftp, sftp, magnet; an absolute folder without
  `..`). Whoever can edit a Gladys scene can make aria2 download a link. No
  code path removes a download or a file, or shuts aria2 down.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and aria2 itself.
