"""New element that takes storey, type and material from an existing one."""
reference = f.by_type("IfcFurnishingElement")[0] if f.by_type("IfcFurnishingElement") else f.by_type("IfcWall")[0]
storey = ue.get_container(reference)
new = f.create_entity(reference.is_a(), GlobalId=ifcopenshell.guid.new(), OwnerHistory=kit.owner(f), Name="Kopie",
                      ObjectPlacement=kit.place(f, (1.0, 1.0, 0.0), storey.ObjectPlacement),
                      Representation=kit.shape(f, [kit.body(f, [kit.box(f, 0.0, 0.5, 0.0, 0.5, 0.0, 1.0)])]))
kit.join_relations_of(f, reference, [new])
changed = [new.id()]
