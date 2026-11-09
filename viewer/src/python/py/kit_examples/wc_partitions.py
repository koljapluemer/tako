"""Cubicle partitions as one furnishing element: panels from several boxes."""
storey = f.by_type("IfcBuildingStorey")[0]
hpl = kit.style(f, "HPL", (0.62, 0.68, 0.74))
depth, width, thickness, gap, top = 1.5, 1.05, 0.03, 0.15, 2.0
panels = [kit.box(f, 0.0, depth, y, y + thickness, gap, top, hpl) for y in (0.0, width, 2 * width)]
panels.append(kit.box(f, 0.0, thickness, 0.0, 2 * width, gap, top, hpl))
wall = kit.product(f, "IfcFurnishingElement", "WC-Trennwände", storey, (2.0, 2.0, 0.0), panels)
changed = [wall.id()]
