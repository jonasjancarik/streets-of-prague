# CPU integration checkpoint

read_when: Reviewing integration 69aadbe or deciding which checks remain after the queued tunnel correction.

Source `69aadbe03aa9fa4d803b4bddb60509285eb3e10c` passed one CPU-only combined
checkpoint on 3 October 2026, approximately 06:42 Europe/Prague. No source/test
fixture changes were needed. The owned heavy lock was released after the processes exited.

- `npm run build` passed, including TypeScript; the existing bundle-size warning remains.
- Parking/fetch, 12 cutter and 11 complete-ground/seam tests passed.
- Ground order/palette, furniture/survey, boat access and ground-season tests passed.
- Seasonal birds, bilingual season picker/date/weather state, taxi controls and native
  ambulance crew checks passed. Bird clips were not remeasured.
- The existing bus/police/testkit CPU fixture passed, including retained display resources
  and 400 stable renders, beacon lifecycle and entry/route helper checks.
- Full Python unittest discovery passed **once: 100 tests, zero failures**.

Each command's output is retained beside this report. Node's localStorage warnings
and negative-case landmark messages are separate from the passing suite result.
No browser, GPU, source download, data rebuild or production edit occurred.

The map is unchanged and **still blocked by the Mrázovka tunnel regression**:
built `2026-10-03T03:46:50Z`, pipeline `76118bc126`, index SHA-256
`4c51359f27fc3b6892d7e73e955dc56022664df67c1a48ded7448347310357b9`.
This CPU checkpoint does not certify that map safe or validate new UI visually.
It does not include the later queued tunnel correction or standalone harness docs.
Integration ownership is returned to the parent immediately after this evidence commit.
