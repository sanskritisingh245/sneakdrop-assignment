# Notes

## Requirements

- [Node.js](https://nodejs.org/) 22.18 or newer. The server's TypeScript runs directly on Node. The React frontend is built with Vite automatically when the server starts.
- [PostgreSQL](https://www.postgresql.org/) 13 or newer, running locally or reachable by URL.

### Environment variables

All are optional. The defaults work for a local setup.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost/sneakdrop` | PostgreSQL connection string |
| `PORT` | `3000` | Port the server listens on |
| `WEBHOOK_SECRET` | `dev-secret` | Secret used to sign and verify payment webhooks |
| `WEBHOOK_URL` | `http://localhost:<PORT>/webhooks/payment` | URL the fake payment provider sends webhooks to |

## How to run

1. Create the database:

   ```bash
   createdb sneakdrop
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the frontend and start the server:

   ```bash
   npm start
   ```

   Tables are created and the 20 pairs are seeded automatically on first start.

4. Open http://localhost:3000/?user=alice in a browser.

   Change `?user=` to act as a different user, for example `?user=bob` in a second tab.

### Running the tests

With the server running, in a second terminal:

```bash
npm run loadtest
```

The test script resets the database before it runs, so use a database without data you need to keep. The number of simultaneous buyers defaults to 1000 and can be changed, for example `npm run loadtest -- 5000`. Set `API_URL` if the server is not on `http://localhost:3000`.

To type-check the code:

```bash
npm run typecheck
```
