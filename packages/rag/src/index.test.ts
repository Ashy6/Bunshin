import { describe,expect,it } from "vitest";
import { buildGroundedPrompt,chunkText } from "./index";
describe("chunkText",()=>{it("preserves headings and produces ordered chunks",()=>{const chunks=chunkText("# 经历\n\n第一段内容。\n\n## 项目\n\n第二段内容。",20,4);expect(chunks.length).toBeGreaterThan(0);expect(chunks.map((c)=>c.index)).toEqual(chunks.map((_,index)=>index))})});
describe("buildGroundedPrompt",()=>{it("contains identity, refusal and evidence",()=>{const prompt=buildGroundedPrompt("做过什么？",[{title:"简历",text:"负责知识库"}],"小明");expect(prompt).toContain("小明本人的 AI 分身");expect(prompt).toContain("第一人称");expect(prompt).toContain("不要编造");expect(prompt).toContain("负责知识库")})});
