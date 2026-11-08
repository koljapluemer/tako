"""Inspect where a wall has room, as stretches measured from its start."""
wall = f.by_type("IfcWall")[0]
span = kit.wall_span(wall)
print(f"length {span.length:.2f} m, height {span.height:.2f} m, thickness {span.thickness:.2f} m")
print("free at window height:", kit.free_intervals(f, wall, 0.9, 1.4))
print("free at door height:", kit.free_intervals(f, wall, 0.0, 2.0))
