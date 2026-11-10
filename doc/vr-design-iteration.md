# VR design iteration

## Purpose

Tako can already inspect and edit an IFC model from inside a VR session. It has
pointing and paint-based context, browser-owned revisions, undo and redo,
dedicated safe edits, and an IfcOpenShell escape hatch for operations that do
not yet have a named tool.

That substrate is necessary, but it is not yet the complete experience implied
by:

> I want to iterate and brainstorm my building in VR.

The missing layer is not broader IFC schema coverage by itself. It is a design
interaction model for expressing intent, preserving constraints, exploring
alternatives, and understanding consequences quickly enough to sustain a
creative conversation.

This note narrows the broader operation families in
`professional-design-operations.md` to that use case.

## What the IFC data model changes

IFC is a typed object graph. A visible element's type, material, properties,
openings, host, containment, and representation may be separate shared objects
connected through relationships. Express IDs are local to one serialization,
and values may be inherited from a type or overridden on an occurrence.

These facts matter to VR brainstorming primarily as reliability requirements:

- "this wall" must not accidentally change every wall sharing its type or
  material definition;
- moving or resizing a host must keep its openings and fillings coordinated;
- an edit must preserve the intended room, face, level, and neighbouring
  elements;
- revisions and follow-up edits must identify the intended objects after a
  model has been saved and reopened;
- model units and coordinate frames must not leak into the interaction;
- exported alternatives must remain valid in other IFC software.

Material property sets, classifications, document associations, and complete
support for every IFC material form are useful for later professional analysis,
but they should not drive the near-term brainstorming roadmap unless a
user-facing operation needs them.

## Current product boundary

The current system is strongest at focused, object-level interaction:

- inspect or select an existing product;
- find nearby or semantically matching elements;
- rename, move, delete, or change a simple property;
- change materials;
- resize supported doors and windows;
- perform an arbitrary scripted edit;
- revise the latest edit without adding another undo step;
- move through a linear revision history.

This proves that IFC editing and VR viewing can share one local document. The
remaining gap is between manipulating individual model objects and manipulating
a building idea.

## Missing capabilities

### 1. Design alternatives

Brainstorming diverges. A linear undo/redo history cannot comfortably express:

- save the current state as "Option A";
- return to an earlier state and try a courtyard version;
- continue editing either alternative;
- compare the alternatives without losing either one;
- explain their spatial and quantitative differences.

Alternatives should be named branches over the existing revision mechanism,
not duplicate IFC projects with unrelated histories.

Useful comparison views include before/after overlays, changed-region
highlighting, viewpoint-preserving toggles, side-by-side miniature models, and
short summaries of area and quantity differences.

### 2. Constraint-aware spatial edits

The primary operation should describe a design outcome, not an isolated IFC
mutation. Examples are:

- resize an office to 18 square metres, taking space from the corridor;
- widen a room without moving the facade or core;
- move a partition while preserving enclosure and hosted openings;
- raise a storey while retaining valid doors, windows, stairs, and vertical
  relationships;
- change a compound wall while keeping the selected face fixed.

Operations need explicit fixed, preserved, and adjustable sets. When intent is
ambiguous, the result or preview should report the assumption made.

### 3. Building-scale creation and transformation

A useful ideation vocabulary must create and reshape more than existing
products. The high-value primitives are:

- draw rooms, walls, slabs, and openings;
- reshape or extrude a footprint;
- create corridors, cores, courtyards, wings, and shafts;
- add, remove, repeat, or vary storeys;
- split, join, offset, align, mirror, and array elements;
- repeat a bay, facade pattern, room module, or whole floor;
- propagate an edit to deliberately selected similar instances.

`run_ifcopenshell` can prototype these operations. Frequent successful scripts
should graduate into documented and tested kit functions or dedicated tools.

### 4. Multi-object intent and scope

Point selection is necessary but too narrow for most building changes. A user
must also be able to target:

- painted elements or a painted region;
- a facade, storey, wing, zone, or room boundary;
- every element of a type within a stated scope;
- elements similar in geometry, role, material, or placement;
- a spatial phrase such as "the left half" or "everything above this floor".

Before committing a broad edit, the viewer should make the resolved target set
visible. Paint should become a durable input to selection and constraint
resolution rather than only additional prompt context.

### 5. Preview and consequence reporting

Atomic rollback protects the file but does not protect the design conversation
from a valid but unwanted edit. Consequential operations should support a
ghosted proposal that shows:

- what will be added, moved, regenerated, or removed;
- the resolved scope;
- which constraints are fixed or preserved;
- important secondary effects;
- warnings and assumptions.

The user should be able to accept the proposal or revise a parameter without
starting the operation again.

### 6. Immediate comparative feedback

Early design feedback should help compare ideas, not claim final compliance.
Useful fast indicators include:

- room, storey, and total floor area;
- corridor width, headroom, and obvious clearances;
- window-to-wall ratio and orientation;
- approximate material quantities;
- simple daylight or solar-exposure proxies;
- obvious circulation and accessibility problems;
- differences from the parent alternative.

Each result should carry its assumptions and provenance. Detailed structural,
energy, cost, carbon, or regulatory calculations should remain adapters to
specialist systems rather than being improvised inside the viewer.

### 7. Iteration latency

Creative iteration requires the response to feel continuous. A successful edit
currently rebuilds the complete render and collision result. As models grow,
full rebuild, serialization, and spatial-index construction may dominate the
experience even when the edit itself is small.

Measure end-to-end headset experience, including:

- speech end to visible proposal;
- commit to changed geometry becoming visible;
- frame stability during computation and swapping;
- alternative switching from the same viewpoint;
- repeated follow-up edits against cached context.

Incremental invalidation, progressive geometry replacement, and caching recent
alternatives should be pursued when measurements show that full rebuilds break
the interaction loop.

### 8. A promoted operation library

Arbitrary Python is an important capability boundary, but it is not a stable
interaction contract. The first promoted operations should be those that make a
small number of common design conversations dependable:

1. move a partition while preserving rooms and openings;
2. resize a room to a target area or dimension;
3. change storey height and repair affected relationships;
4. add, remove, or repeat a storey;
5. distribute openings by count, spacing, or target ratio;
6. reshape a footprint while preserving selected edges;
7. create a corridor, core, or courtyard from spatial constraints;
8. propagate an edit to an explicit set of similar elements.

Every promoted operation needs scope preview, relationship-safe mutation,
structured warnings, semantic verification after reopen, and support for
`revise_edit`.

## Near-term reliability work

Only a small part of general IFC completeness is immediately relevant to the VR
use case:

1. Resolve the `set_property` contract. The Python implementation can create an
   occurrence property set and carry inherited values into an override, while
   current user-facing documentation says missing property sets are refused.
   Decide the intended behavior, update the tool description, and test shared
   and type-inherited property sets.
2. Add fixtures for type-versus-occurrence edits and shared material, layer,
   profile, representation, and property definitions. An edit to "this" must
   not silently affect peers.
3. Verify semantic round trips: effective materials and properties, hosting,
   containment, units, placement, and rendered geometry must survive
   save/reopen. Byte equality is neither expected nor sufficient.
4. Report provenance consistently: occurrence, type, direct relationship,
   inference, or default.

Profile-set material editing, material physical properties, classifications,
EPDs, and document links remain reasonable later work, especially for
engineering and performance comparisons. They are not prerequisites for the
first useful spatial brainstorming workflow.

## Proposed product milestone

The next integrative milestone should be:

> In VR, create two named layout alternatives by moving partitions and resizing
> rooms, compare their areas and changed regions, then continue editing either
> alternative.

An acceptable end-to-end scenario is:

1. The user points at or paints the rooms and partitions in scope.
2. They save the current design as "Option A".
3. They ask to enlarge one room to a target area while keeping the facade and
   core fixed.
4. Tako previews the affected walls, openings, and adjacent rooms, including
   the preservation rules and resulting areas.
5. The user says "take the extra space only from the corridor side" and the
   proposal is revised in place.
6. The user accepts the proposal as "Option B".
7. The two alternatives can be toggled or viewed as miniature models from a
   stable viewpoint, with changed regions and area differences visible.
8. The user selects either alternative and continues editing it.
9. Both alternatives export as semantically valid IFC models.

This milestone exercises alternatives, constraints, spatial editing, preview,
follow-up intent, comparative feedback, persistence, and IFC integrity without
requiring broad support for every professional BIM workflow.

## Non-goals for this milestone

- comprehensive IFC schema authoring;
- a relational mirror of the IFC graph;
- automatic code-compliance certification;
- detailed structural, energy, cost, or embodied-carbon simulation;
- multi-user concurrent editing;
- perfect inference of unstated design intent;
- promoting every possible scripted edit into a dedicated tool.

The guiding rule is to implement IFC depth when it makes a concrete design
conversation safer, faster, or more expressive. Schema coverage alone is not a
user outcome.
