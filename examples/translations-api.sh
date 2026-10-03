#!/usr/bin/env bash
# 多语言译文字幕（保存 → 复核 → 按语言导出）完整调用示例。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/translations-api.sh [BASE_URL]
# 例如：bash examples/translations-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

# ---- 小工具：POST/PUT JSON，输出 HTTP 状态码与响应体 ----
req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
# 取响应体（去掉末尾状态码行）；取状态码
body_of() { sed '$d'; }
code_of() { tail -1; }
# 从 JSON 文本中提取标量字段（需要 python3）
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（演示数据准备，与译文功能无关） ==="
out="$(req POST /api/projects '{"name":"译文 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}')"
PID="$(echo "$out" | body_of | jget id)"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
SUBV="$(echo "$out" | body_of | jget sub_version)"
echo "项目 id=$PID，字幕 id=$SID1（你好世界）/ $SID2（欢迎光临），字幕集 v$SUBV"

echo
echo "=== 1. 保存英文译文（携带字幕 ID 与读取时行版本；新建无需译文版本） ==="
out="$(req PUT "/api/projects/$PID/translations/en" \
  "{\"subtitle_id\":$SID1,\"text\":\"Hello world\",\"cue_version\":1}")"
echo "第一行：HTTP $(echo "$out" | code_of)（201 新建；译文版本 v1，状态 ok）"
out="$(req PUT "/api/projects/$PID/translations/en" \
  "{\"subtitle_id\":$SID2,\"text\":\"Welcome\",\"cue_version\":1}")"
echo "第二行：HTTP $(echo "$out" | code_of)"
echo "同一行再存法语译文（同一语言每行最多一份，不同语言互不影响）："
req PUT "/api/projects/$PID/translations/fr" \
  "{\"subtitle_id\":$SID1,\"text\":\"Bonjour\",\"cue_version\":1}" | code_of

echo
echo "=== 2. 并列查询：原文 / 译文 / 状态（含缺译与历史统计） ==="
req GET "/api/projects/$PID/translations/en" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
for it in d["items"]:
    t = it["translation"]
    line = "  行%d 原文「%s」 -> " % (it["subtitle"]["idx"]+1, it["subtitle"]["text"])
    print(line + ("译文「%s」[%s]" % (t["text"], t["status"]) if t else "（缺译）"))
print("  summary:", d["summary"])'

echo
echo "=== 3. 非法与过期示例 ==="
echo "空语言代号 → HTTP $(req PUT "/api/projects/$PID/translations/%20" '{"subtitle_id":1,"text":"x","cue_version":1}' | code_of)（400）"
echo "缺 cue_version → HTTP $(req PUT "/api/projects/$PID/translations/en" "{\"subtitle_id\":$SID1,\"text\":\"x\"}" | code_of)（400）"
echo "更新已存在的译文但未携带译文版本 → HTTP $(req PUT "/api/projects/$PID/translations/en" "{\"subtitle_id\":$SID1,\"text\":\"Hi\",\"cue_version\":1}" | code_of)（409，返回当前译文）"
echo "超过当前最大字数（默认 30）→ HTTP $(req PUT "/api/projects/$PID/translations/en" "{\"subtitle_id\":$SID1,\"text\":\"$(python3 -c 'print("x"*31)')\",\"cue_version\":1,\"translation_version\":1}" | code_of)（422，未保存）"
echo "行版本过期 → HTTP $(req PUT "/api/projects/$PID/translations/en" "{\"subtitle_id\":$SID1,\"text\":\"Hi\",\"cue_version\":999,\"translation_version\":1}" | code_of)（409，返回当前行）"

echo
echo "=== 4. 修改源字幕文本 → 该行的各语言译文一起转“待复核” ==="
out="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"你好呀，世界"}')"
SUBV="$(echo "$out" | body_of | jget sub_version)"
req GET "/api/projects/$PID/translations/en" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  en 行1 状态:", d["items"][0]["translation"]["status"],
      "（源快照:", d["items"][0]["translation"]["source"]["text"], "）")'
echo "  （仅锁定或展示顺序变化不会使译文失效；此处是文本变化）"

echo
echo "=== 5. 在当前源行上确认待复核译文 ==="
echo "译文版本过期 → HTTP $(req POST "/api/projects/$PID/translations/en/confirm" \
  "{\"subtitle_id\":$SID1,\"cue_version\":2,\"translation_version\":99}" | code_of)（409，不改数据）"
out="$(req POST "/api/projects/$PID/translations/en/confirm" \
  "{\"subtitle_id\":$SID1,\"cue_version\":2,\"translation_version\":1}")"
echo "正确版本确认 → HTTP $(echo "$out" | code_of)，状态：$(echo "$out" | body_of | jget translation.status)，译文版本 v$(echo "$out" | body_of | jget translation.version)"

echo
echo "=== 6. 重排：被删行的译文留作历史，新行视为缺译（不按序号挪用） ==="
echo "（重排会删除未锁定行并以新 ID 重建，即使文本时间相同）"
out="$(req POST "/api/projects/$PID/layout" "{\"sub_version\":$SUBV}")"
SUBV="$(echo "$out" | body_of | jget sub_version)"
NEW_SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
NEW_SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "重排完成：新行 id=$NEW_SID1 / $NEW_SID2（原行 $SID1 / $SID2 已删除）"
req GET "/api/projects/$PID/translations/en" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  当前行译文:", ["（缺译）" if it["translation"] is None else it["translation"]["text"] for it in d["items"]])
print("  历史译文:", [(h["subtitle_id"], h["text"], h["status"]) for h in d["history"]])'

echo
echo "=== 7. 按语言导出：缺译 → 422 列出缺漏；补齐 → 201 生成不可变快照 ==="
out="$(req POST "/api/projects/$PID/translations/en/exports" '{}')"
echo "缺译时导出 → HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  missing:", [m["message"] for m in d["missing"]])'
out="$(req PUT "/api/projects/$PID/translations/en" \
  "{\"subtitle_id\":$NEW_SID1,\"text\":\"Hello there\",\"cue_version\":1}")"
echo "给新行 1 补译 → HTTP $(echo "$out" | code_of)"
out="$(req PUT "/api/projects/$PID/translations/en" \
  "{\"subtitle_id\":$NEW_SID2,\"text\":\"Welcome\",\"cue_version\":1}")"
echo "给新行 2 补译 → HTTP $(echo "$out" | code_of)"
out="$(req POST "/api/projects/$PID/translations/en/exports" "{\"sub_version\":$SUBV}")"
echo "补齐后导出 → HTTP $(echo "$out" | code_of)，版本 v$(echo "$out" | body_of | jget version)"
echo "$out" | body_of | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"])' | sed 's/^/  /'

echo
echo "=== 8. 快照不可变：更新译文后再导出 v2，v1 内容不变 ==="
TRV="$(req GET "/api/projects/$PID/translations/en" | body_of | jget items.0.translation.version)"
CUEV="$(req GET "/api/projects/$PID/translations/en" | body_of | jget items.0.subtitle.version)"
echo "更新第一条译文 → HTTP $(req PUT "/api/projects/$PID/translations/en" \
  "{\"subtitle_id\":$NEW_SID1,\"text\":\"Hello, world!\",\"cue_version\":$CUEV,\"translation_version\":$TRV}" | code_of)"
out="$(req POST "/api/projects/$PID/translations/en/exports" '{}')"
echo "再次导出 → HTTP $(echo "$out" | code_of)，版本 v$(echo "$out" | body_of | jget version)"
echo "v1 快照内容（仍为旧译文 Hello there）："
req GET "/api/projects/$PID/translations/en/exports/1" | body_of | grep -A2 '^1$' | sed 's/^/  /'

echo
echo "=== 9. 语言汇总 / 导出版本列表 / 原文导出仍可用 ==="
req GET "/api/projects/$PID/translations" | body_of | python3 -m json.tool --no-ensure-ascii
echo "en 导出版本列表："
req GET "/api/projects/$PID/translations/en/exports" | body_of | python3 -m json.tool --no-ensure-ascii
echo "原文导出（不含译文）→ HTTP $(req POST "/api/projects/$PID/exports" '{}' | code_of)"

echo
echo "完成。"
