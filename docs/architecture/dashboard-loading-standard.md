# NEW BI dashboard loading standard

Dashboard loading must preserve the page shell while data is being fetched.

- Render the dashboard header and permitted action buttons immediately.
- Render the dashboard's existing filters according to its normal layout and behavior.
- Show the corporate loading skeleton only in the results area that depends on the pending data.
- Use a percentage only when loaded and total counts describe the same authorized population and query scope. Otherwise show indeterminate progress and the current loading stage.
- Keep prior results visible during an update only when they belong to the same authorized dashboard scope, and label them as previous data.
- Keep the page shell visible for empty and error states; provide the existing retry action in the results area.
- Avoid layout shifts and do not show temporary zero-valued metadata before the corresponding data has arrived.

Apply this pattern when implementing or updating dashboards. This document does not authorize changing other dashboard loading behavior by itself.
