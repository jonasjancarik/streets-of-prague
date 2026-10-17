---
read_when: Changing taxi passenger controls, pickup routing, request state, or cancellation/rebooking feedback.
---

# Taxi passenger controls

On touch, the existing Taxi button now states its current action:

| Passenger state | English | Czech |
|---|---|---|
| No request | Taxi | Taxi |
| Choosing a service | Close taxi menu | Zavřít nabídku taxi |
| Driver coming or waiting | Cancel taxi | Zrušit taxi |

Previously the button stayed labelled Taxi while an order was active, even though
its next tap cancelled that order. The keyboard T shortcut still opens/closes the
menu or cancels a request, E still boards/exits, and numeric/menu choices retain
existing behaviour. The contextual Get in control remains the boarding action.
That button update did not change routing, traffic, parking, service pricing or fare calculation.

Cancellation releases the driver and its stop/route, hides the marker, and clears
transient loading, speed, target, timers, distance and notice state. An explicit
cancel then displays the existing cancellation notice. Reopening the menu clears
that old notice, and a successful new booking starts with clean request feedback.
Failure messages remain visible after a failed booking, until reopening or timeout.

Button copy updates only when passenger state or language changes. Its `data-t`
key follows the action, so global language changes do not reset it to a misleading
Taxi label. Existing English/Czech service and price copy is preserved.

`node scripts/check-taxi-controls.mjs` exercises the real Taxis class with one
straight fake traffic edge: booking, arrival, driver release, cancel/rebook,
notice/loading reset, no-charge cancellation, keyboard choices, language switches
and hail/app/insufficient-money/no-street failures. The test uses the repository TypeScript
compiler plus minimal DOM/Vite-environment shims in Node; no browser/GPU or new
dependency is needed. It deliberately does not test routing quality.

Typecheck passed. The single real-game browser batch used this private worktree on
5203, map `centrum` built `2026-10-02T20:16:12Z`, WebGPU, `?touch&lang=en`, 390×844,
clear weather and fixed summer date (URL requested 14:00; screenshots show
14:03 after startup, then simulation was paused). On Vodičkova, actual UI taps opened the menu,
ordered Zipp, cancelled and released its driver, reopened without the stale notice,
and rebooked Hopla. Labels changed exactly as above, loading state was false, and
button rectangles remained inside the viewport (52 px tall). The browser closed
and released the shared GPU lock promptly. These are desktop touch-sized checks,
not a physical-phone result.

[Menu](evidence/taxi-controls/taxi-menu-en.png),
[coming](evidence/taxi-controls/taxi-coming-en.png),
[rebooked](evidence/taxi-controls/taxi-rebooked-en.png), and
[interaction states](evidence/taxi-controls/interaction.json) preserve the result.
Czech labels and notice/reset behavior pass the actual-class CPU tests. An extra
browser language-switch probe was inconclusive: it imported an unversioned i18n
module while Vite served a timestamped one, and the UI remained English. The failed
probe is preserved and is not counted as a Czech browser pass.

A full build/gameplay suite and routing benchmark were intentionally skipped for
this control-copy/request-reset change. Physical-phone and traffic-stall/pathfinding
investigations remain open. No testkit or main/touch control API was changed.

## Pickup routing

Bookings check directed street connections before selecting a taxi or creating one.
A nearer taxi on a disconnected lane cannot hide a farther taxi with a route to the
pickup. A stopped taxi already within the existing 7 m boarding distance of the
player and pickup can wait on its current lane, provided it is on a street at the
same ground level. A moving taxi that has passed the pickup still needs a legal
route back. Taxi trips keep their existing plans toward destinations beyond the
loaded streets; fares, service areas and ordinary traffic rules are unchanged.

`node scripts/check-taxi-routing.mjs` exercises real street graphs, routes and
traffic: disconnected candidates, stopped and moving pickups, one-way loops,
junction progress, and rejected spawn points before car allocation. It also checks
that unavailable service does not charge a fare. These checks establish graph
reachability; they do not establish that physical traffic jams cannot delay a taxi.
