Test-only certificates standing in for Apple's notification-signing chain (see
lib/app-store-notifications.js). The keys here protect nothing: the real server pins Apple's own
root, so these are trusted only by tests that pass their fingerprint in explicitly.

Generated with LibreSSL on macOS, valid for 100 years: `ext.cnf` holds the extensions, including the
two Apple marker OIDs. `plain.pem` is a leaf WITHOUT the marker, to prove the check is real.
