"""Add a plain door at the best free spot of a wall, styled like an existing door."""
width, height = PARAMS.get("width", 0.9), PARAMS.get("height", 2.0)
wall = next(w for w in f.by_type("IfcWall") if any(end - start >= width for start, end in kit.free_intervals(f, w, 0.0, height)))
reference = f.by_type("IfcDoor")[0]

along = kit.best_along(f, wall, width, 0.0, height)
opening = kit.cut_opening(f, wall, along, 0.0, width, height, "Tür")
door = kit.fill_opening(f, "IfcDoor", opening, width, height, kit.body(f, kit.door_items(f, width, height, kit.styles_from(f, reference))), "Tür")
changed = [door.id(), wall.id()]
