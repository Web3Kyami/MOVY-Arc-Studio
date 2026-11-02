CREATE TABLE IF NOT EXISTS movy_database_binding (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  network_name TEXT NOT NULL CHECK (network_name IN ('mainnet', 'testnet')),
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
