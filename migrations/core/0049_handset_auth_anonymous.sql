-- Hourly counts of unsigned auth attempts. Only a bounded number of them become
-- audit receipts; the rest are counted here without address, path or payload.
CREATE TABLE hnd_auth_anonymous (
 window INTEGER PRIMARY KEY, attempts INTEGER NOT NULL CHECK(attempts>0)
);
