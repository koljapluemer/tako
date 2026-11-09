"""Add a two-panel window at the best free spot of a wall."""
width, height, sill = PARAMS.get("width", 1.2), PARAMS.get("height", 1.4), PARAMS.get("sill", 0.9)
wall = next(w for w in f.by_type("IfcWall") if any(end - start >= width for start, end in kit.free_intervals(f, w, sill, height)))
panels = PARAMS.get("panels", [{"pos": "left", "kind": "casement"}, {"pos": "right", "kind": "fixed"}])

along = kit.best_along(f, wall, width, sill, height)
opening = kit.cut_opening(f, wall, along, sill, width, height, "Fenster")
item_map = kit.rep_map(f, kit.body(f, kit.window_items(f, width, height, panels, kit.styles_from(f))))
window = kit.fill_opening(f, "IfcWindow", opening, width, height, kit.mapped_body(f, item_map), "Fenster")
kit.assign_type(f, [window], kit.window_type(f, "Fenster - neu", panels, [item_map]))
changed = [window.id(), wall.id()]
