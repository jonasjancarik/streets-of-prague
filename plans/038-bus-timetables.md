---
read_when: Changing the bus departure board, PID bus data, or how buses spawn and follow scheduled trips.
---

# Bus timetables

## Departure board

Use PID boarding departures at the platform where the player stands. Keep platform IDs and use the game clock with representative weekday, Saturday and Sunday service, including departures after midnight. Show the next scheduled departure on each line and distinguish it from the countdown for a bus already driving nearby. Keep the live countdown available to Space-to-wait. Check the reported Nové náměstí platform against PID and replay the scene in Czech.

## Line 227 pilot

The Prague build exports the 227 trip variants and stop calls. In local Wednesday replays, the 13:38 Nedvězí trip reached platform C at Nové náměstí at about 13:38:01 while waiting on foot, after driving ahead, and after flying ahead at about 69 m above ground. Each replay used a fresh game with background traffic controlled. No replay produced a duplicate or departed early. A wreck blocked the approach in a separate exploratory run.

Run `node scripts/check-bus-pilot.mjs` against a built Prague map to check both approaches and preserve trip identity and delay through a vehicle unload. The pilot is local pending release with a rebuilt map.

### Requirements

Export each supported trip's route variant and ordered stop visits. Check both directions against the road graph, including the reported turn into Morávkova. Give each service-day trip one identity across the timetable, board and traffic simulation. Keep the scheduled time and estimated arrival for the same stop visit together.

Estimate progress outside the simulated area from stop times and distance along the route. Insert the bus on a connected, loaded, clear lane outside the camera's view. Give waiting players priority and use one scheduler for covered trips. Once a bus is driving, use its actual progress, hold it at stops until the scheduled departure when early, and carry delays forward when it leaves the simulated area. Keep occupied buses attached across tile loads. Reconcile trips after clock jumps.

Test waiting and boarding, traffic delays, overtaking, helicopter travel, tile gaps and clock jumps. Look for visible spawns, duplicate buses, early departures and advertised pickups that the bus skips. Use the results to decide how widely to enable scheduled spawning.
