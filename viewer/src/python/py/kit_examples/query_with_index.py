"""Use the spatial index instead of walking IFC relations by hand."""
exterior_windows = [fa for fa in si.facts.values() if fa.ifc_class.startswith("IfcWindow") and fa.exterior]
print(len(exterior_windows), "exterior windows")
print(round(sum(fa.width * fa.height for fa in exterior_windows), 2), "m2 of glazing")
for room in list(si.rooms.values())[:5]:
    print(room.name, room.long_name, room.storey, sorted(room.neighbours))
