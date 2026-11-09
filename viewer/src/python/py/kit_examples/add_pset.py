"""Add properties to an element."""
wall = f.by_type("IfcWall")[0]
kit.add_pset(f, wall, "Tako_Notes", {"Reviewed": True, "Comment": "checked on site"})
changed = [wall.id()]
