# Alerts

`/pro/alerts` lists the alerts on the database you are looking at, open ones
first, with filters for those that need attention, open, closed and all. The bell
in the top bar counts the open ones, colored by the most severe. An alert's page
says what matched, which rule raised it and at which version, and who was told.

Alerts come only from rules: nothing opens an alert unless a rule that is turned
on matched it. A rule belongs to one database, the one selected when it was made.
Administrators manage rules from the **Rules** button on the alerts page
(`/pro/alerts/rules`).

Operators and administrators can **acknowledge** an open alert, until it closes
or for an hour, four hours or a day. It then leaves everybody's count and its
notifications are held. Conditions, such as a stalled queue, close by themselves
when they stop matching. Events, such as a pg-boss warning or a failed operation,
have nothing to stop: they close when somebody resolves them, or after 24 hours.

Rules are on [their own page](./alert-rules.md), and where alerts go on [Destinations](./destinations.md).

API tokens can list open alerts and acknowledge one: see [the API](./api.md#alerts).
