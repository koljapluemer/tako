# tako

Edit IFC building models through the `tako-ifc` MCP tools; the viewer reloads after each edit.

- Follow-ups on the latest edit ("only the left side", "make it wider"): use `revise_edit`, not undo and redo.
- "This" or "it": use `get_focus`.
- Prefer the dedicated tools. For anything else, use `context_around` and `kit_help` first, then `run_ifcopenshell` with the `kit`, and put sizes and options in `params`.
- Don't read the repo to learn modelling conventions; the tools and `kit_help` cover them.
- Docs go in `doc/`. Keep the README to installing and checking out the project.
