"""Create a VoiceGuard API key and print it once."""
import argparse
import secrets

from . import db


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a VoiceGuard API key")
    parser.add_argument("--role", choices=("reviewer", "analyst"), required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    raw_key = secrets.token_urlsafe(32)
    db.init_db()
    with db.get_connection() as conn:
        key_id = db.create_api_key(conn, key_hash=db.hash_api_key(raw_key), role=args.role, label=args.label)
    print(f"Created API key #{key_id} ({args.role}, {args.label})")
    print("Save this key now; it will not be shown again:")
    print(raw_key)


if __name__ == "__main__":
    main()
