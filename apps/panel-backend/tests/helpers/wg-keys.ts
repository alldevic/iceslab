/**
 * One WireGuard keypair of the right shape for fixtures that go through
 * AmneziawgConfigSchema: 44 characters of standard base64 ending in `=`, what
 * the node's validateWGKey wants (see WgKeySchema in inbounds.schemas.ts). Not
 * a secret, not a matching pair: the schema checks the shape only.
 */
export const WG_TEST_PRIVATE_KEY = 'YAT+bEESM0kh2iD3ujUlW1SQ/HeGjigNdYRs8B5ZSEE=';
export const WG_TEST_PUBLIC_KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo=';
