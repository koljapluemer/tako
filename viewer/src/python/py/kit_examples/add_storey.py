"""Duplicate a storey directly above itself; higher storeys move up."""
source = next(s for s in sorted(f.by_type("IfcBuildingStorey"), key=lambda s: s.Elevation or 0) if (s.Elevation or 0) >= 0)
result = kit.copy_storey(f, source, PARAMS.get("name", "Neues Geschoss"))
changed = result["changed"]
