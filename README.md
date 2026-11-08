# tako

Browser-owned IFC editing through Claude Code. The application is TypeScript,
`web-ifc`, Three.js and OPFS; the optional MCP process only relays tool calls to
the active browser tab.

## Install and run

Requires Node 22+, [just](https://github.com/casey/just), and the `claude` CLI.

```sh
just up
```

Open `http://localhost:5173`, import an IFC file, then use Claude. Projects and
their revisions stay in that browser profile. Export the IFC to make an ordinary
file backup.

For a standalone headset on the same LAN:

```sh
just vr
```

The current MCP bridge is desktop-local; standalone-headset agent control is not
part of this version.

## Check

```sh
just check
```

This typechecks and builds the browser and the TypeScript MCP bridge.
