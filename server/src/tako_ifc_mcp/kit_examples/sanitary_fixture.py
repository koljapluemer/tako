"""A WC with typed attributes, showing ellipses and a custom ceramic style."""
storey = f.by_type("IfcBuildingStorey")[0]
ceramic = kit.style(f, "Keramik", (0.96, 0.96, 0.95))
items = [kit.ellipse(f, 0.3, 0.0, 0.25, 0.18, 0.28, 0.40, ceramic), kit.box(f, 0.0, 0.22, -0.13, 0.13, 0.24, 0.40, ceramic)]
wc = kit.product(f, "IfcSanitaryTerminal", "WC", storey, (1.0, 1.0, 0.0), items, PredefinedType="TOILETPAN")
changed = [wc.id()]
