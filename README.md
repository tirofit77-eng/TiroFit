# TiroFit

Calorie, training and recovery coach built around balancing the week, not the day.

This is the standalone web version. It runs as a static site (Netlify) and stores data on the device for now. Accounts, cloud sync and the AI coach are coming next.

Food data: USDA FoodData Central (public domain) and the TempoLife food dataset (CC-BY-4.0).

## Accounts and sync
`/api/sync` (netlify/functions/sync.mjs, logic in netlify/sync-core.mjs) stores each account's log in Netlify Blobs
(stores `tirofit-users` and `tirofit-data`). Passwords are PBKDF2-hashed. Tokens are signed with `AUTH_SECRET` if set,
otherwise a random secret kept in the users store. Nothing else to configure.
