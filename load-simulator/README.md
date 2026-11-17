# load-simulator

Drives the public Rides API with simulated riders (open-loop arrivals) and reports throughput, latency percentiles, fleet utilisation, pipeline backlog and analytics lag. Sizes a temporary simulated fleet through Marketplace and removes it afterwards.

```bash
npm ci && npm run build && npm start   # reads an optional .env (see .env.example)
```

See the [repository README](../README.md).
