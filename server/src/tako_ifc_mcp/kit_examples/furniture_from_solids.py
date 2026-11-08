"""Build a free-standing element from simple solids, in storey-relative coordinates."""
storey = f.by_type("IfcBuildingStorey")[0]
wood = kit.style(f, "Holz", (0.65, 0.48, 0.30))
top = kit.box(f, 0.0, 1.6, 0.0, 0.8, 0.72, 0.76, wood)
legs = [kit.cylinder(f, x, y, 0.03, 0.0, 0.72, wood) for x in (0.1, 1.5) for y in (0.1, 0.7)]
table = kit.product(f, "IfcFurnishingElement", "Tisch", storey, (2.0, 3.0, 0.0), [top, *legs])
changed = [table.id()]
