# Professional building-design operations

## Purpose

The current operation kit grew from exploratory user sessions and is therefore
biased toward visible, object-level edits. This document reframes the kit around
the recurring work of architects, building engineers, and BIM coordinators while
they prototype, review, coordinate, iterate, and test building designs.

The central finding is that professional design work is not primarily a sequence
of isolated IFC object mutations. It is a repeated loop:

> inspect -> compare with intent and constraints -> modify a connected system ->
> recompute consequences -> coordinate -> verify

The useful unit of work is therefore closer to "make this room meet its area
target without breaking the corridor" or "reroute this duct while preserving
slope and ceiling clearance" than "move IFC object #381".

## Evidence base

The research covered professional guidance, software documentation, academic
studies, industry workflow material, and practitioner accounts across
architecture, structural engineering, MEP engineering, BIM coordination,
performance analysis, and regulatory review.

Recurring findings were:

- Design develops from program and massing through spatial coordination and
  technical detail. Architects repeatedly change spatial relationships, form,
  openings, assemblies, materials, and building systems.
- Iteration is unavoidable and crosses disciplines. A local change can affect
  structure, services, cost, documentation, constructability, and compliance.
- Coordination is a first-class activity. Preparation, navigation, inspection,
  querying, annotation, recording, and switching between 2D and 3D views are
  regular parts of design review.
- Clash detection covers only geometric symptoms. Evacuation problems,
  unsupported elements, inadequate shafts, maintenance access, and
  constructability often require expert interpretation.
- Structural engineers work with analytical representations that are linked to,
  but distinct from, the physical model.
- MEP work is system-oriented: define spaces and loads, place equipment and
  terminals, connect systems, route and size networks, then verify flow,
  elevation, slope, pressure, access, and clearance.
- Performance analysis is iterative. Teams compare alternatives during design,
  not just at final audit.
- Professional BIM deliverables contain coordinated information as well as
  geometry.

## Operation families

### 1. Understand and interrogate the design

These operations usually precede an edit:

- Select by spatial, semantic, system, or relationship criteria.
- Isolate a storey, zone, facade, system, fire compartment, or discipline.
- Measure distance, clearance, area, volume, slope, headroom, and opening ratio.
- Trace containment, hosting, connectivity, support, and load paths.
- Find similar instances and exceptions.
- Compare revisions or design alternatives.
- Generate section cuts or focused contexts around an issue.
- Summarize rooms, systems, assemblies, quantities, and unresolved problems.

`context_around` should eventually be backed by reusable relationship and
measurement primitives rather than only returning nearby objects.

### 2. Program and space planning

Common operations include:

- Create, divide, merge, rename, and reclassify spaces.
- Set target area, occupancy, capacity, department, and environmental needs.
- Move a boundary while preserving adjacent enclosure.
- Resize a room to a target area or dimension.
- Swap or reorder adjacent rooms.
- Insert corridors, cores, shafts, service zones, and circulation loops.
- Test adjacency and separation requirements.
- Stack or align spaces between storeys.
- Calculate gross and net area, efficiency, and program variance.
- Create and compare spatial alternatives.

A professional operation would express "resize this office to 18 square metres,
taking space from the corridor side" rather than directly moving one wall by a
given distance.

### 3. Massing, site, and building form

Architects prototype by:

- Extruding, offsetting, tapering, cutting, joining, splitting, terracing, and
  rotating masses.
- Changing footprint depth, wing length, courtyard size, floor-to-floor height,
  or storey count.
- Orienting a building relative to site, sun, views, access, and wind.
- Fitting an envelope to setbacks, height limits, or a site boundary.
- Replicating or varying bays and modules.
- Comparing floor area, envelope area, surface-to-volume ratio, solar exposure,
  and approximate cost across alternatives.

These operations should accept constraints and report metrics for the resulting
alternative.

### 4. Architectural assemblies

Frequent detailed operations include:

- Draw, extend, trim, split, join, offset, align, and replace walls.
- Change compound construction while preserving the intended wall face.
- Create or edit floors, slabs, roofs, ceilings, soffits, and their boundaries.
- Add, move, resize, group, and pattern openings.
- Replace door and window types while preserving instance intent.
- Distribute openings by bay, spacing, count, or target window-to-wall ratio.
- Create curtain grids, panels, mullions, and facade modules.
- Add stairs, landings, ramps, rails, and guards.
- Place casework, sanitary fixtures, furniture, and equipment using layout
  rules.
- Propagate changes to repeated rooms, storeys, or facade bays.

The existing door and window recipes cover a useful but narrow part of this
family.

### 5. Circulation, accessibility, and life safety

Professionals repeatedly inspect:

- Door clear width, approach clearance, swing conflicts, and hardware side.
- Accessible routes, turning circles, ramps, landings, thresholds, and lifts.
- Travel distance, dead ends, exit count, exit separation, and exit capacity.
- Stair width, rise and run, headroom, landings, guards, and handrails.
- Corridor width and pinch points.
- Occupant load and egress allocation.
- Fire compartment boundaries and penetrations.
- Fire-rating continuity across walls, floors, doors, shafts, and openings.

These should initially be diagnostic operations with traceable assumptions.
Jurisdiction-specific automatic correction should come later.

### 6. Structural design and coordination

Typical operations are:

- Create and edit grids and levels.
- Generate columns, walls, beams, braces, slabs, foundations, and framing systems
  from grids or support geometry.
- Change span direction, bay spacing, section, material, depth, or structural
  role.
- Align elements to grid intersections and levels.
- Extend or trim framing to supports.
- Join members and repair analytical connectivity.
- Add slab, wall, and beam penetrations.
- Create analytical nodes, members, panels, links, loads, and boundary
  conditions.
- Simplify physical geometry into an analytical model.
- Import analysis results and update member sizes.
- Check unsupported elements, discontinuities, excessive spans, headroom
  conflicts, and penetrations near critical regions.

The physical model, analytical model, calculations, and documentation must stay
coordinated as the design changes.

### 7. MEP systems

High-value MEP operations include:

- Define thermal spaces and zones.
- Place equipment, terminals, fixtures, panels, devices, and risers.
- Connect elements into supply, return, waste, vent, hydronic, fire-protection,
  and electrical systems.
- Route ducts, pipes, conduit, and cable tray between connectors.
- Reroute around obstacles with configurable clearance and bend rules.
- Maintain gravity slope and invert elevation.
- Size branches and mains from loads or fixture demand.
- Resize shafts and ceiling zones around coordinated services.
- Create sleeves and penetrations.
- Find disconnected connectors, invalid flow direction, insufficient access,
  and impossible fittings.
- Balance system branches and calculate pressure-drop paths.
- Reserve installation, insulation, maintenance, and replacement clearances.

A routing primitive needs explicit rules for system type, slope, bend radius,
clearance envelopes, and preferred routing zones.

### 8. Coordination and review

The recurring coordination loop is:

1. Combine discipline models.
2. Validate coordinates, versions, classifications, and expected content.
3. Run hard, soft, clearance, and rule-based checks.
4. Group duplicate symptoms into meaningful issues.
5. Inspect an issue in plan, section, and 3D.
6. Decide which discipline owns the resolution.
7. Modify the responsible system.
8. Re-run only affected checks.
9. Record the resolution and verify closure.

Relevant operations include:

- Clash and clearance queries with tolerances.
- Maintenance and installation clearance volumes.
- Change detection between revisions.
- Issue creation tied to elements and viewpoints.
- Model comparison by discipline or storey.
- Suggestions based on which system is least constrained.
- Rerouting or resizing while protecting designated elements.
- Batch verification of resolved issues.
- Audits for missing data, duplicates, fragments, invalid containment, or
  incorrect storeys.

The meaningful outcome is issue resolution, not a raw clash count.

### 9. Performance and option testing

Design teams compare alternatives for:

- Area and program fit.
- Quantities and approximate cost.
- Envelope area and material quantities.
- Daylight, glare, views, and solar exposure.
- Heating and cooling loads and energy demand.
- Thermal bridging and envelope continuity.
- Natural ventilation potential.
- Acoustic separation and reverberation.
- Embodied carbon and water demand.
- Structural weight and utilization.
- Operational access and maintainability.

Most of these should be stable model-extraction and adapter operations feeding
specialist solvers, rather than reimplementations of those solvers in `kit.py`.

### 10. Information and deliverable quality

Frequent information operations include:

- Assign classifications, types, systems, materials, and property sets.
- Batch-edit consistently selected elements.
- Validate required properties at a project milestone.
- Normalize naming and identifiers.
- Generate room, door, window, equipment, finish, and quantity schedules.
- Detect schedule and model discrepancies.
- Track design status, responsibility, approval, and revision.
- Validate IFC exchange requirements or IDS rules.
- Review drawing and model consistency.

Professional BIM delivers coordinated information, not just geometry.

## Recommended kit structure

The kit should distinguish three layers.

### A. Atomic, relationship-safe primitives

Candidate primitives include:

- `move`, `rotate`, `copy`, `delete`
- `trim`, `extend`, `split`, `join`, `offset`
- `align_to_grid`, `align_to_level`, `match_elevation`
- `replace_type`, `change_profile`, `change_layers`
- `create_opening`, `move_opening`, `resize_opening`
- `host`, `unhost`, `connect`, `disconnect`
- `assign_space`, `assign_storey`, `assign_system`
- `create_clearance`, `create_penetration`
- `array_linear`, `array_on_curve`, `repeat_by_bay`
- `propagate_to_similar`

Each primitive must preserve or explicitly repair containment, hosting,
openings, connections, materials, quantities, and relevant representations.

### B. Constraint-aware design operations

Candidate operations include:

- `resize_space(target_area, fixed_edges, preferred_direction)`
- `move_partition(preserve_rooms, preserve_openings)`
- `distribute_windows(target_ratio, spacing, edge_clearance)`
- `fit_stair(floor_height, available_run, code_profile)`
- `generate_framing(grid, supports, span_direction)`
- `reroute_system(obstacles, clearance, protected_zones)`
- `resize_shaft(required_services, clearance)`
- `align_stack_across_storeys()`
- `resolve_clash(strategy, movable_disciplines)`
- `replace_assembly(preserve_face, preserve_hosts)`

This layer captures professional intent while remaining revisable through
explicit parameters.

### C. Checks and closed-loop workflows

Candidate checks include:

- `check_egress`
- `check_accessibility`
- `check_space_program`
- `check_system_connectivity`
- `check_structural_continuity`
- `check_clearances`
- `check_envelope_continuity`
- `check_required_information`
- `compare_options`
- `compare_revisions`
- `verify_issue_resolution`

A check should return affected elements, measurements, assumptions, severity,
and applicable operation classes. It should not silently change the model.

## Product implications

Several cross-cutting properties matter more than the breadth of the initial
operation list:

- **Intent preservation:** operations should target design relationships, not
  only object coordinates.
- **Explicit constraints:** fixed faces, protected systems, tolerances, preferred
  directions, and rule profiles should be parameters.
- **Preview and diagnostics:** report expected consequences before committing a
  broad or ambiguous transformation.
- **Revision support:** material choices, sizes, strategies, and constraints
  should live in `params` so `revise_edit` can reapply an alternative cleanly.
- **Dependency awareness:** edits should identify affected hosts, openings,
  spaces, systems, quantities, and checks.
- **Local verification:** rerun the relevant checks after an edit rather than
  relying only on a global geometric validity test.
- **Traceability:** preserve which assumption, constraint, or issue caused a
  change.
- **Alternative comparison:** expose metrics and differences, not merely the
  resulting geometry.

## Suggested implementation priority

1. Core manipulation: move, copy, delete, align, offset, split and join, replace
   type, and robust opening operations.
2. Spatial operations: rooms, boundaries, target-area resizing, adjacency, and
   area summaries.
3. Pattern operations: grids, bays, repeated openings, repeated storeys, and
   facade modules.
4. Coordination: clearance envelopes, model diff, grouped clashes, issue-local
   context, and post-edit rechecking.
5. Structure: grids and levels, framing generation, physical and analytical
   relationships, and penetrations.
6. MEP: connectors, systems, slopes, routing, rerouting, shafts, and access
   clearance.
7. Circulation and code diagnostics: doors, stairs, accessible paths, egress,
   and compartment continuity.
8. Performance adapters: quantities, daylight and solar, energy, carbon,
   structural analysis, and HVAC analysis exchange.
9. Information quality: classification, milestone requirements, schedules, and
   IDS-like validation.

The operation roadmap should come primarily from professional design loops,
discipline relationships, and the checks that cause practitioners to revise a
design. Session logs remain useful for language resolution, discoverability,
defaults, and error handling, but should not define the underlying operation
model.

## Sources

### Professional and industry guidance

- [AIA: Defining the architect's basic services](https://www.aia.org/resource-center/defining-the-architects-basic-services)
- [RIBA Plan of Work](https://www.riba.org/work/insights-and-resources/riba-plan-of-work/)
- [Penn State: BIM Uses](https://bim.psu.edu/Uses/)
- [buildingSMART: Use Case Management](https://ucm.buildingsmart.org/en/use-case-management)
- [Autodesk: Beginner Workflows for Architecture](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-GetStarted/files/GUID-E69C4858-FD23-4BB1-941F-EE6BAC29844A.htm)
- [Autodesk: Architectural Design](https://help.autodesk.com/cloudhelp/2026/ENU/RevitLT-ArchDes/files/GUID-87D435CD-B2E7-49DB-B5B6-22A352C5DC54.htm)
- [Autodesk: Industry Workflows for Structure](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-GetStarted/files/GUID-D96218D7-461C-44BC-818B-3744EDFEEED5.htm)
- [Autodesk: The Structural Analytical Model](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-StructEng/files/GUID-2A0652F2-2AC1-4009-9AD4-ADF41E0048D2.htm)
- [Autodesk: Mechanical, Electrical, and Plumbing](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-MEPEng/files/GUID-195C2C6C-5E2C-422E-A44D-FB3FDFDE276A.htm)
- [ASHRAE Handbook: Energy Estimating and Modeling Methods](https://handbook.ashrae.org/Handbooks/F21/IP/f21_ch19/f21_ch19_ip.aspx)
- [Whole Building Design Guide: Design Objectives](https://www.wbdg.org/do)
- [Whole Building Design Guide: Post-Occupancy Evaluations](https://www.wbdg.org/resources/post-occupancy-evaluations)

### Research

- [Design iteration in construction projects: Review and directions](https://www.sciencedirect.com/science/article/pii/S1110016816303210)
- [Characterizing interactions with BIM tools and artifacts in building design coordination meetings](https://www.sciencedirect.com/science/article/pii/S0926580516304307)
- [How does BIM influence decision-making in project design?](https://www.sciencedirect.com/science/article/pii/S2666721524000450)
- [Cost-benefit analysis of BIM-enabled design clash detection and resolution](https://www.tandfonline.com/doi/abs/10.1080/01446193.2020.1802768)
- [Comparing concurrent and sequential practices in cloud-BIM interdisciplinary collaborative design](https://www.tandfonline.com/doi/pdf/10.1080/17452007.2025.2549493)
- [From Pre-design to Operation: Productivity Metrics Using BIM](https://doi.org/10.2174/0118748368379847250324051020)

### Practitioner-oriented material

- [BIM Workflows for the Structural Engineer: Design to Fabrication](https://static.au-uw2-prd.autodesk.com/Class_Handout_BES469184.pdf)
- [Bluebeam: PDF Markup Guide for Architects](https://www.bluebeam.com/resources/pdf-markups-for-architects-2026-guide/)
- [Aurecon: Worksharing and Coordination](https://client_a.pages.aurecon.dev/client-a-construction-protocols/delivery-protocols/quality-and-governance/worksharing-and-coordination/)
