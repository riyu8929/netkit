// node tools/netkit/test.js
// サンプルはすべて架空（RFC1918 / ドキュメント用アドレス）。本業の Config は使わない。
const assert = require("node:assert/strict");
const nk = require("./netkit.js");

let n = 0;
function t(name, fn) {
  fn();
  n++;
  console.log("  OK  " + name);
}

// ---- CIDR → ワイルドカード ----
t("基本の置換。ほかの文字は変えない", () => {
  const src = "access-list 110 permit ip 10.10.20.0/24 172.16.0.0/19 log";
  const r = nk.cidrToWildcard(src);
  assert.equal(r.text, "access-list 110 permit ip 10.10.20.0 0.0.0.255 172.16.0.0 0.0.31.255 log");
  assert.equal(r.count, 2);
});

t("字下げ・複数行・CIDR の無い行はそのまま", () => {
  const src = " permit tcp 192.168.1.0/24 any eq 443\n remark 通す\n\n deny ip any any";
  assert.equal(nk.cidrToWildcard(src).text, " permit tcp 192.168.1.0 0.0.0.255 any eq 443\n remark 通す\n\n deny ip any any");
});

t("/32 と /0 のオプション", () => {
  const src = "permit ip 10.0.0.5/32 0.0.0.0/0";
  assert.equal(nk.cidrToWildcard(src).text, "permit ip 10.0.0.5 0.0.0.0 0.0.0.0 255.255.255.255");
  assert.equal(nk.cidrToWildcard(src, { host: true, any: true }).text, "permit ip host 10.0.0.5 any");
});

t("ホスト部に1が立っていたら警告、指定があれば直す", () => {
  const r = nk.cidrToWildcard("permit ip 10.1.2.3/16 any");
  assert.equal(r.warnings.length, 1);
  assert.equal(r.text, "permit ip 10.1.2.3 0.0.255.255 any");
  assert.equal(nk.cidrToWildcard("permit ip 10.1.2.3/16 any", { fixNetwork: true }).text, "permit ip 10.1.0.0 0.0.255.255 any");
});

t("IP ではないもの（日付・バージョン番号・/33）は置換しない", () => {
  const src = "version 15.2/3 date 2026/09/17 bad 10.0.0.0/33 x1.2.3.4/8 NET_10.0.0.0/8";
  assert.equal(nk.cidrToWildcard(src).text, src);
});

// ---- 範囲 ----
t("172.16.0.0 0.0.31.255 の範囲", () => {
  const r = nk.describeRange("172.16.0.0 0.0.31.255");
  assert.equal(r.first, "172.16.0.0");
  assert.equal(r.last, "172.16.31.255");
  assert.equal(r.count, 8192);
  assert.equal(r.cidr, "172.16.0.0/19");
  assert.equal(r.kind, "ワイルドカード");
});

t("サブネットマスク・CIDR・host", () => {
  assert.equal(nk.describeRange("192.168.10.0 255.255.254.0").cidr, "192.168.10.0/23");
  assert.equal(nk.describeRange("10.0.0.0/8").last, "10.255.255.255");
  assert.equal(nk.describeRange("host 10.0.0.1").count, 1);
});

t("不連続ワイルドカードは『範囲ではない』と返す", () => {
  const r = nk.describeRange("10.0.0.0 0.0.255.0");
  assert.equal(r.discontiguous, true);
  assert.equal(r.count, 256);
});

t("読めない入力はエラー", () => {
  assert.ok(nk.describeRange("abc").error);
  assert.ok(nk.describeRange("10.0.0.300 0.0.0.255").error);
});

// ---- Config 差分（IOS） ----
const iosA = `!
hostname SW-A
!
vlan 110
 name USERS
!
interface GigabitEthernet1/0/1
 description PC
 switchport access vlan 110
 switchport mode access
!
interface GigabitEthernet1/0/24
 description UPLINK
 switchport trunk allowed vlan 110,120
 switchport mode trunk
!
end`;

const iosB = `Building configuration...
!
hostname SW-A
!
vlan 110
 name USERS
!
vlan 130
 name PRINTER
!
interface GigabitEthernet1/0/24
 description UPLINK
 switchport trunk allowed vlan 110,120,130
 switchport mode trunk
!
interface GigabitEthernet1/0/1
 description PC-2F
 switchport access vlan 110
 switchport mode access
 spanning-tree portfast
!
end`;

t("IOS: 並び順の違いは差分にしない、セクション単位で出す", () => {
  const d = nk.diffConfigs(iosA, iosB);
  assert.equal(d.format, "ios");
  const s = Object.fromEntries(d.sections.map((x) => [x.section, x]));
  // 新しい vlan 130 はトップレベルに重ねて出さず、「vlan 130（新規）」の1か所だけ
  assert.equal(s["（トップレベル）"], undefined);
  assert.deepEqual(s["vlan 130（新規）"].added, ["name PRINTER"]);
  assert.deepEqual(s["interface GigabitEthernet1/0/1"].changed, [{ from: "description PC", to: "description PC-2F" }]);
  assert.deepEqual(s["interface GigabitEthernet1/0/1"].added, ["spanning-tree portfast"]);
  assert.deepEqual(s["interface GigabitEthernet1/0/24"].changed, [
    { from: "switchport trunk allowed vlan 110,120", to: "switchport trunk allowed vlan 110,120,130" },
  ]);
  assert.equal(s["hostname SW-A"], undefined);
  assert.deepEqual(d.summary, { added: 2, removed: 0, changed: 2 });
});

t("セクションごと消えたときは（削除）を付けて1か所だけ", () => {
  const d = nk.diffConfigs(iosB, iosA);
  const s = Object.fromEntries(d.sections.map((x) => [x.section, x]));
  assert.equal(s["（トップレベル）"], undefined);
  assert.deepEqual(s["vlan 130（削除）"].removed, ["name PRINTER"]);
});

t("中身の無いセクションが増えたときは、親に見出しを出す", () => {
  const d = nk.diffConfigs("hostname A\n", "hostname A\nvlan 999\n");
  assert.deepEqual(d.sections, [{ section: "（トップレベル）", added: ["vlan 999"], removed: [], changed: [] }]);
});

t("同じ Config なら差分ゼロ", () => {
  assert.equal(nk.diffConfigs(iosA, iosA).sections.length, 0);
});

// ---- Config 差分（FortiGate） ----
const fgA = `#config-version=FGT60F-7.2.8
config firewall address
    edit "LAN_USERS"
        set subnet 192.168.10.0 255.255.255.0
    next
end
config firewall policy
    edit 1
        set name "LAN-to-WAN"
        set srcintf "internal"
        set dstintf "wan1"
        set action accept
        set service "ALL"
        set nat enable
    next
end`;

const fgB = `#config-version=FGT60F-7.2.9
config firewall address
    edit "LAN_USERS"
        set subnet 192.168.10.0 255.255.255.0
    next
    edit "PRINTER"
        set subnet 192.168.30.10 255.255.255.255
    next
end
config firewall policy
    edit 1
        set name "LAN-to-WAN"
        set srcintf "internal"
        set dstintf "wan1"
        set action accept
        set service "HTTP" "HTTPS" "DNS"
        set nat enable
        set logtraffic all
    next
end`;

t("FortiGate: edit 単位で追加・変更を出す", () => {
  const d = nk.diffConfigs(fgA, fgB);
  assert.equal(d.format, "fortigate");
  const s = Object.fromEntries(d.sections.map((x) => [x.section, x]));
  // 新しい edit は親に重ねて出さず、子のセクション名に（新規）を付けて1か所だけに出す
  assert.equal(s["config firewall address"], undefined);
  assert.deepEqual(s['config firewall address › edit "PRINTER"（新規）'].added, ["set subnet 192.168.30.10 255.255.255.255"]);
  const p = s["config firewall policy › edit 1"];
  assert.deepEqual(p.changed, [{ from: 'set service "ALL"', to: 'set service "HTTP" "HTTPS" "DNS"' }]);
  assert.deepEqual(p.added, ["set logtraffic all"]);
  assert.deepEqual(d.summary, { added: 2, removed: 0, changed: 1 });
});

console.log(`\n${n}件すべて通過`);
