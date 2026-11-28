-- Synthetic rows of an installation of the old fork (040410ac), for the tests of
-- the move (milestone 20.3) and for a quick look at the pre-check. Covers every
-- class of data the move treats: nodes with the old hardening keys, egress
-- policies on a node and on cascade members, a cascade with directions and
-- links, every protocol of profile, plain WireGuard bindings, the geo settings,
-- response rules (one edited), devices, history. The real stand fills a real old
-- panel through its API instead; this is the SQL stand-in.
--
-- Ids are fixed so the tests can name them: 0000...-N where N tells the kind.

-- admin, token, CA, region
INSERT INTO admin_users (id, username, password_hash, role, updated_at, totp_secret, totp_enabled)
VALUES ('a0000000-0000-4000-8000-000000000001', 'admin', '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', 'admin', now(), 'JBSWY3DPEHPK3PXP', true);
INSERT INTO api_tokens (id, name, token_hash, scopes, created_by_admin_id)
VALUES ('a1000000-0000-4000-8000-000000000001', 'minishop', repeat('ab', 32), '["users:read","users:write"]', 'a0000000-0000-4000-8000-000000000001'),
       ('a1000000-0000-4000-8000-000000000002', 'monitor', repeat('cd', 32), '["nodes:read"]', NULL);
INSERT INTO keygen_ca (id, cert_pem, private_key_pem, panel_client_cert_pem, panel_client_key_pem)
VALUES (1, '-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----', '-----BEGIN PRIVATE KEY-----ca-----END PRIVATE KEY-----', '-----BEGIN CERTIFICATE-----panel-----END CERTIFICATE-----', '-----BEGIN PRIVATE KEY-----panel-----END PRIVATE KEY-----');
INSERT INTO regions (id, name, code, updated_at) VALUES ('b0000000-0000-4000-8000-000000000001', 'Europe', 'eu', now());

-- nodes: 1 entry with every key of the old hardening, 2 hysteria exit, 3 xray exit, 4 middle hop, 5 soft-deleted
INSERT INTO nodes (id, name, address, country_code, status, heartbeat_secret, protocol, region_id, consumption_multiplier, domain, hardening, warp_enabled, warp_account, singbox_engine, core_version, egress_tune, port_hopping_start, port_hopping_end, updated_at)
VALUES
 ('c0000000-0000-4000-8000-000000000001', 'entry-ru', '198.51.100.1', 'RU', 'online', '\x0102030405060708090a0b0c0d0e0f10', 'xray', 'b0000000-0000-4000-8000-000000000001', 3, 'entry.example.org',
  '{"ufwLockdown":true,"fail2ban":true,"sshAllowlist":["10.0.0.1","192.0.2.0/24"],"pool":{"asn":"AS64500","provider":"acme","burned":false},
    "zapret2":{"enabled":true,"strategy":"fake,multisplit"},"bridgeNonXrayInbounds":true,
    "egressPolicy":[
      {"geosite":["category-ru"],"geoip":["ru"],"target":"direct"},
      {"domain":["domain:blocked.example"],"target":"block"},
      {"geosite":["google"],"target":"warp"},
      {"geosite":["rkn"],"target":"zapret2"},
      {"port":"443","network":"tcp","target":"direct"},
      {"ip":["10.0.0.0/8"],"target":"direct"}]}',
  true, '{"license":"x","privateKey":"k"}', false, '1.2.3', '{"strategy":"fake","score":0.9}', 20000, 30000, now()),
 ('c0000000-0000-4000-8000-000000000002', 'exit-nl', '198.51.100.2', 'NL', 'online', '\x1102030405060708090a0b0c0d0e0f10', 'hysteria', NULL, 1, NULL,
  '{"fail2ban":true,"egressPolicy":[{"geosite":["netflix"],"target":"link-out"}]}', false, NULL, true, '1.2.3', NULL, 20000, 50000, now()),
 ('c0000000-0000-4000-8000-000000000003', 'exit-de', '198.51.100.3', 'DE', 'online', '\x2102030405060708090a0b0c0d0e0f10', 'xray', NULL, 1, NULL, NULL, false, NULL, false, '1.2.3', NULL, NULL, NULL, now()),
 ('c0000000-0000-4000-8000-000000000004', 'mid-fi', '198.51.100.4', 'FI', 'online', '\x3102030405060708090a0b0c0d0e0f10', 'xray', NULL, 1, NULL, '{"fail2ban":false}', false, NULL, false, '1.2.3', NULL, NULL, NULL, now()),
 ('c0000000-0000-4000-8000-000000000005', 'old-box', '198.51.100.5', 'US', 'offline', '\x4102030405060708090a0b0c0d0e0f10', 'xray', NULL, 1, NULL, NULL, false, NULL, false, NULL, NULL, NULL, NULL, now());
UPDATE nodes SET deleted_at = now() WHERE name = 'old-box';
INSERT INTO node_bootstrap_tokens (id, node_id, token, expires_at) VALUES ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'bootstrap-token-1', now() + interval '1 day');

-- profiles of every core
INSERT INTO profiles (id, name, protocol, description, config, enabled, engine) VALUES
 ('d0000000-0000-4000-8000-000000000001', 'reality', 'xray', 'vless reality', '{"subprotocol":"vless","security":"reality","network":"tcp","realityDest":"www.microsoft.com:443","realityServerNames":["www.microsoft.com"],"realityPrivateKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","realityPublicKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","realityShortIds":["ab12"],"flow":"xtls-rprx-vision"}', true, NULL),
 ('d0000000-0000-4000-8000-000000000002', 'ws', 'xray', NULL, '{"subprotocol":"vless","security":"tls","network":"ws","path":"/ws","host":"example.org"}', true, NULL),
 ('d0000000-0000-4000-8000-000000000003', 'hy2', 'hysteria', NULL, '{"hostname":"h.example.org","obfsPassword":"obfs","pinnedPeerCertSha256":"0000000000000000000000000000000000000000000000000000000000000000"}', true, NULL),
 ('d0000000-0000-4000-8000-000000000004', 'awg', 'amneziawg', NULL, '{"subnet":"10.8.0.0/24","serverPrivateKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","serverPublicKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","obfuscation":{"jc":4,"jmin":64,"jmax":128,"s1":32,"s2":40,"h1":100,"h2":200,"h3":300,"h4":400}}', true, NULL),
 ('d0000000-0000-4000-8000-000000000005', 'wg', 'wireguard', NULL, '{"subnet":"10.9.0.0/24","serverPrivateKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","serverPublicKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}', true, NULL),
 ('d0000000-0000-4000-8000-000000000006', 'mtg', 'mtproto', 'explicit mtg', '{"domain":"www.cloudflare.com"}', true, 'mtproto'),
 ('d0000000-0000-4000-8000-000000000007', 'mtproxy', 'mtproto', NULL, '{"domain":"www.cloudflare.com"}', true, 'mtprotoproxy'),
 ('d0000000-0000-4000-8000-000000000008', 'ss', 'shadowsocks', NULL, '{"method":"2022-blake3-aes-256-gcm"}', true, NULL),
 ('d0000000-0000-4000-8000-000000000009', 'tuic', 'tuic', NULL, '{"serverName":"www.bing.com","congestionControl":"bbr"}', true, NULL),
 ('d0000000-0000-4000-8000-00000000000a', 'mieru', 'mieru', NULL, '{"mtu":1400}', true, NULL);
-- The old API writes a binding without overrides as JSON null, not SQL NULL (stand 20.3): both shapes here.
INSERT INTO profile_node_bindings (id, profile_id, node_id, port, public_host, overrides, enabled) VALUES
 ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 443, NULL, NULL, true),
 ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 8443, 'ws.example.org', '{"path":"/ws2"}', true),
 ('e0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000002', 4443, NULL, 'null'::jsonb, true),
 ('e0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000001', 51820, NULL, NULL, true),
 ('e0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000003', 51821, NULL, 'null'::jsonb, true),
 ('e0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000003', 8444, NULL, NULL, true),
 ('e0000000-0000-4000-8000-000000000007', 'd0000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000004', 8445, NULL, 'null'::jsonb, true),
 ('e0000000-0000-4000-8000-000000000008', 'd0000000-0000-4000-8000-000000000008', 'c0000000-0000-4000-8000-000000000004', 8388, NULL, NULL, true),
 ('e0000000-0000-4000-8000-000000000009', 'd0000000-0000-4000-8000-000000000009', 'c0000000-0000-4000-8000-000000000002', 8446, NULL, 'null'::jsonb, true),
 ('e0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-000000000003', 8447, NULL, NULL, true),
 ('e0000000-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 443, NULL, 'null'::jsonb, true);
INSERT INTO hosts (id, binding_id, remark, priority, port_override, sni_override, alpn, updated_at) VALUES
 ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'Reality Moscow', 1, 8443, 'www.microsoft.com', ARRAY['h2','http/1.1'], now()),
 ('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000003', 'Hy2 NL', 2, NULL, NULL, ARRAY[]::text[], now());

-- squads
INSERT INTO groups (id, name, description, updated_at, routing_preset, hwid_device_limit) VALUES
 ('90000000-0000-4000-8000-000000000001', 'main', 'the main squad', now(), 'ru-split', 3),
 ('90000000-0000-4000-8000-000000000002', 'extra', NULL, now(), NULL, NULL);
INSERT INTO group_profiles (group_id, profile_id)
SELECT '90000000-0000-4000-8000-000000000001'::uuid, id FROM profiles WHERE name IN ('reality','ws','hy2','awg','wg','ss')
UNION ALL SELECT '90000000-0000-4000-8000-000000000002'::uuid, id FROM profiles WHERE name IN ('mtg','mtproxy','tuic','mieru');
INSERT INTO group_hosts (group_id, host_id) VALUES ('90000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001'), ('90000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002');
INSERT INTO route_policies (id, name, ordinal, direct_domains, block_domains, updated_at)
VALUES ('88000000-0000-4000-8000-000000000001', 'my-lists', 100, ARRAY['ext:geo-custom.dat:MYCAT','example.com'], ARRAY['ext:geo-custom.dat:Ghost','ads.example.com'], now());
INSERT INTO group_route_policies (group_id, policy_id) VALUES ('90000000-0000-4000-8000-000000000001', '88000000-0000-4000-8000-000000000001');

-- cascades: c1 (three positions, two directions), c2 (one position with a node that is also in c1)
INSERT INTO cascades (id, name, enabled, updated_at, mode, next_direction_tag, auto_profile, auto_label)
VALUES ('70000000-0000-4000-8000-000000000001', 'main-chain', true, now(), 'chain', 3, false, 'Auto line'),
       ('70000000-0000-4000-8000-000000000002', 'second', true, now(), 'chain', 1, false, NULL);
INSERT INTO cascade_positions (id, cascade_id, "position", entry_protocol, link_protocol) VALUES
 ('71000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 1, 'vless', 'xray'),
 ('71000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 2, NULL, 'shadowsocks'),
 ('71000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000001', 3, NULL, 'hysteria'),
 ('71000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000002', 1, NULL, NULL);
INSERT INTO cascade_position_nodes (position_id, node_id, egress_policy) VALUES
 ('71000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', '[{"geosite":["ru"],"target":"direct"}]'),
 ('71000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000004',
  '[{"domain":["ext:geo-custom.dat:MYCAT"],"target":"direction","directionTag":1},{"geosite":["netflix"],"target":"direction","directionTag":2},{"ip":["1.1.1.1"],"target":"direct"},{"geosite":["x"],"target":"zapret2"}]'),
 ('71000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000003', '[{"geosite":["a"],"target":"block"}]'),
 ('71000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000003', '[{"geosite":["y"],"target":"block"}]');
INSERT INTO cascade_directions (id, cascade_id, tag, country_code, label) VALUES
 ('72000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 1, 'NL', 'Dutch line'),
 ('72000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 2, 'DE', NULL);
INSERT INTO cascade_direction_nodes (direction_id, node_id) VALUES
 ('72000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002'),
 ('72000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000003');
INSERT INTO cascade_links (id, cascade_id, from_node_id, to_node_id, direction_tag, protocol, config) VALUES
 ('73000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000002', 1, 'vless', '{"port":4443,"uuid":"11111111-1111-4111-8111-111111111111"}'),
 ('73000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000003', 2, 'vless', '{"port":4444,"uuid":"22222222-2222-4222-8222-222222222222"}');
INSERT INTO cascade_hops (id, cascade_id, node_id, "position", entry_protocol, link_protocol, link_config)
VALUES ('74000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000003', 1, NULL, 'xray', '{"port":4445}');
INSERT INTO group_cascade_exits (group_id, cascade_id, exit_node_id) VALUES
 ('90000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002'),
 ('90000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003'),
 ('90000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002');

-- users: 24, the 24th soft-deleted; numeric_id comes from the sequence
INSERT INTO users (id, short_id, username, status, expire_at, traffic_limit_bytes, traffic_limit_strategy, subscription_token, hysteria_password, amneziawg_private_key, amneziawg_public_key, naive_password, xray_uuid, hwid_device_limit, email, enabled_protocols, routing_preset, updated_at)
SELECT ('a2000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       'sid' || lpad(i::text, 5, '0'),
       'user' || i,
       CASE WHEN i % 7 = 0 THEN 'disabled' WHEN i % 5 = 0 THEN 'expired' ELSE 'active' END,
       now() + (i || ' days')::interval,
       CASE WHEN i % 3 = 0 THEN NULL ELSE i * 1073741824::bigint END,
       'no_reset',
       'tok' || md5('sub' || i) || lpad(i::text, 4, '0'),
       md5('hy' || i),
       encode(sha256(('awgpriv' || i)::bytea), 'base64'),
       encode(sha256(('awgpub' || i)::bytea), 'base64'),
       md5('naive' || i),
       ('a3000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       CASE WHEN i = 4 THEN 2 ELSE NULL END,
       CASE WHEN i % 4 = 0 THEN 'user' || i || '@example.org' ELSE NULL END,
       '["hysteria","xray"]'::jsonb,
       CASE WHEN i % 6 = 0 THEN 'cn-split' ELSE NULL END,
       now()
FROM generate_series(1, 24) AS i;
UPDATE users SET deleted_at = now(), status = 'deleted' WHERE username = 'user24';
UPDATE users SET external_squad_uuid = 'squad-' || username WHERE username IN ('user1', 'user2');
INSERT INTO group_members (group_id, user_id) SELECT '90000000-0000-4000-8000-000000000001'::uuid, id FROM users WHERE username ~ '^user([1-9]|1[0-2])$';
INSERT INTO group_members (group_id, user_id) SELECT '90000000-0000-4000-8000-000000000002'::uuid, id FROM users WHERE username ~ '^user(1[0-9]|20)$';
INSERT INTO user_traffic (user_id, used_traffic_bytes, lifetime_traffic_bytes, online_at) SELECT id, numeric_id * 1000000, numeric_id * 5000000, now() FROM users;
-- WireGuard: device 1 of everyone is the user's own key, user5 holds two more
INSERT INTO wg_devices (id, user_id, label, private_key, public_key, created_at)
SELECT ('a4000000-0000-4000-8000-' || lpad(numeric_id::text, 12, '0'))::uuid, id, NULL, amneziawg_private_key, amneziawg_public_key, created_at FROM users;
INSERT INTO wg_devices (id, user_id, label, private_key, public_key, preshared_key, bytes_in, bytes_out, last_seen_at)
SELECT ('a5000000-0000-4000-8000-00000000000' || n)::uuid, u.id, 'phone' || n, encode(sha256(('devpriv5' || n)::bytea), 'base64'), encode(sha256(('devpub5' || n)::bytea), 'base64'), encode(sha256(('psk5' || n)::bytea), 'base64'), 1000 * n, 2000 * n, now()
FROM users u, generate_series(1, 2) n WHERE u.username = 'user5';
INSERT INTO amneziawg_peers (id, profile_id, user_id, ip, device_id)
SELECT gen_random_uuid(), 'd0000000-0000-4000-8000-000000000004'::uuid, u.id, '10.8.0.' || (u.numeric_id + 1), d.id
FROM users u JOIN wg_devices d ON d.user_id = u.id AND d.label IS NULL WHERE u.numeric_id <= 8;
INSERT INTO amneziawg_peers (id, profile_id, user_id, ip, device_id)
SELECT gen_random_uuid(), 'd0000000-0000-4000-8000-000000000004'::uuid, u.id, '10.8.0.200', d.id FROM users u JOIN wg_devices d ON d.user_id = u.id WHERE d.label = 'phone1';
-- HWID devices; the user agent of one is 600 characters long
INSERT INTO hwid_user_devices (id, user_id, hwid, label, platform, os_version, device_model, user_agent)
SELECT gen_random_uuid(), u.id, 'hwid-' || u.numeric_id || '-' || n, 'dev' || n, CASE n WHEN 1 THEN 'Android' ELSE 'iOS' END, '14', 'Pixel 7', 'Happ/4.3.0/' || u.numeric_id
FROM users u, generate_series(1, 2) n WHERE u.numeric_id <= 4;
UPDATE hwid_user_devices SET user_agent = repeat('long-ua/', 75) WHERE hwid = 'hwid-1-1';
-- history
INSERT INTO node_usage_history (node_id, hour, download_bytes, upload_bytes) SELECT 'c0000000-0000-4000-8000-000000000001'::uuid, date_trunc('hour', now()) - (h || ' hours')::interval, h * 1000, h * 500 FROM generate_series(1, 48) h;
INSERT INTO node_user_usage_history (node_id, user_id, date, bytes_in, bytes_out) SELECT 'c0000000-0000-4000-8000-000000000001'::uuid, id, current_date - 1, 1000, 2000 FROM users WHERE numeric_id <= 10;
INSERT INTO node_user_traffic_snapshot (node_id, user_id, cum_in, cum_out, updated_at) SELECT 'c0000000-0000-4000-8000-000000000001'::uuid, id, 1, 2, now() FROM users WHERE numeric_id <= 10;
INSERT INTO subscription_events (id, user_id, event_type, reason) SELECT numeric_id, id, 'created', 'seed' FROM users WHERE numeric_id <= 5;
INSERT INTO subscription_request_history (id, user_id, request_ip, user_agent) SELECT numeric_id, id, '203.0.113.' || numeric_id, 'Hiddify/2.0' FROM users WHERE numeric_id <= 5;

-- settings, with the geo sources and categories of the old fork
INSERT INTO app_settings (key, value, is_public, updated_at) VALUES
 ('brandName', '"Iceslab Test"', true, now()),
 ('subscriptionProfileTitle', '"My VPN"', false, now()),
 ('subscriptionEntryPoolSize', '2', false, now()),
 ('subscriptionCustomRoutingRules', '[{"type":"field","domain":["ext:geo-custom.dat:MYCAT","example.net"],"outboundTag":"direct"}]', false, now()),
 ('subscriptionWgDns', '["1.1.1.1"]', false, now()),
 ('recipeSources', '[]', false, now()),
 ('geoSources', '[
   {"id":"default","name":"runetfreedom (official)","geositeUrl":"https://github.com/runetfreedom/russia-v2ray-rules-dat/releases/latest/download/geosite.dat","geoipUrl":"https://github.com/runetfreedom/russia-v2ray-rules-dat/releases/latest/download/geoip.dat","enabled":true,"refreshIntervalHours":24,"trusted":true},
   {"id":"src-1","name":"My Geo Source","geositeUrl":"https://geo.example.org/geosite.dat","geoipUrl":"https://geo.example.org/geoip.dat","enabled":true,"refreshIntervalHours":12,"trusted":false}]', false, now()),
 ('geoCategories', '[
   {"id":"cat1","name":"MyCat","domainRefs":[{"sourceId":"default","category":"category-ru"},{"sourceId":"src-1","category":"streaming"}],"ipRefs":[{"sourceId":"src-1","category":"ru"}],"manualDomains":["example.org","full:www.example.net"],"manualIps":["203.0.113.0/24"],"excludeDomains":["bad.example.org"],"enabled":true},
   {"id":"cat2","name":"Dotted.Name","domainRefs":[{"sourceId":"default","category":"geolocation-cn"}],"ipRefs":[],"manualDomains":[],"manualIps":[],"excludeDomains":[],"enabled":true},
   {"id":"cat3","name":"Ghost","domainRefs":[{"sourceId":"missing","category":"z"}],"ipRefs":[],"manualDomains":[],"manualIps":[],"excludeDomains":[],"enabled":true}]', false, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- response rules: one edited by the operator, one of its own
UPDATE subscription_response_rules SET ua_pattern = '(?i)outline|myout', updated_at = now() WHERE name = 'Outline';
INSERT INTO subscription_response_rules (id, name, ua_pattern, format, priority, updated_at) VALUES ('80000000-0000-4000-8000-000000000001', 'MyApp', '(?i)myapp', 'singbox', 95, now());
