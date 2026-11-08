"""A new straight wall as a solid in a storey."""
storey = f.by_type("IfcBuildingStorey")[0]
length, thickness, height = 4.0, 0.2, 2.7
wall = kit.product(f, "IfcWall", "Wand-neu", storey, (1.0, 1.0, 0.0), [kit.box(f, 0.0, length, -thickness / 2, thickness / 2, 0.0, height)])
changed = [wall.id()]
