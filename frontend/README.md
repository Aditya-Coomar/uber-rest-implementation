# frontend

Kerb rider app (Next.js App Router): **Ride**, **Trips**, **Insights** and **Load lab**. The browser calls same-origin `/rides-api` and `/sim-api` paths that `next.config.ts` proxies to the local backend; `npm start` at the repository root writes the targets into `.env.local`.

```bash
npm run dev        # development
npm run build && npm start
npm run lint && npm run typecheck
```

Card details are validated in the browser and never sent: only `card_<brand>_<last4>` is used as the payment method. See the [repository README](../README.md).
