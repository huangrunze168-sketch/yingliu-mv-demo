import importlib.util
import json
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


SERVER_PATH = pathlib.Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("yingliu_demo_server_agent_json", SERVER_PATH)
assert SPEC and SPEC.loader
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class AgentJsonParserTests(unittest.TestCase):
    def test_parses_plain_json(self) -> None:
        self.assertEqual(server.parse_agent_json('{"shots": [{"id": "SH01"}]}')["shots"][0]["id"], "SH01")

    def test_parses_markdown_fence_and_trailing_text(self) -> None:
        content = '```json\n{"project_summary": "完成"}\n```\n以上为结果。'
        self.assertEqual(server.parse_agent_json(content)["project_summary"], "完成")

    def test_parses_json_with_braces_inside_string(self) -> None:
        content = '{"creative_brief": "画面包含 {门框}，但仍是合法字符串"} trailing'
        self.assertEqual(server.parse_agent_json(content)["creative_brief"], "画面包含 {门框}，但仍是合法字符串")

    def test_prefers_most_complete_concatenated_object(self) -> None:
        content = '{"project_summary":"主结果","shots":[]}\n{"project_summary":"不得覆盖","shots":[{"id":"SH01"}],"timeline":[]}'
        result = server.parse_agent_json(content)
        self.assertEqual(result["project_summary"], "不得覆盖")
        self.assertEqual(result["shots"][0]["id"], "SH01")
        self.assertEqual(result["timeline"], [])

    def test_unwraps_dsh_event_result(self) -> None:
        content = '{"event":"tool","data":{"frames":6}}\n{"event":"final","result":{"project_summary":"完成","analysis_cards":[{"title":"需求"}],"shots":[{"id":"SH01"}]}}'
        result = server.parse_agent_json(content)
        self.assertEqual(result["project_summary"], "完成")
        self.assertEqual(result["shots"][0]["id"], "SH01")

    def test_rejects_non_json_output(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "不是合法 JSON"):
            server.parse_agent_json("模型暂时无法处理")

    def test_reference_segments_cover_full_duration(self) -> None:
        segments = server.reference_scene_segments(12.0, [2.0, 5.5, 9.0])
        self.assertEqual([item["source_time"] for item in segments], [
            "00:00.000–00:02.000",
            "00:02.000–00:05.500",
            "00:05.500–00:09.000",
            "00:09.000–00:12.000",
        ])

    def test_reference_segments_merge_without_gaps(self) -> None:
        cuts = [float(index) for index in range(1, 20)]
        segments = server.reference_scene_segments(20.0, cuts, limit=4)
        self.assertEqual(len(segments), 4)
        self.assertEqual(segments[0]["start_seconds"], 0.0)
        self.assertEqual(segments[-1]["end_seconds"], 20.0)
        for current, following in zip(segments, segments[1:]):
            self.assertEqual(current["end_seconds"], following["start_seconds"])

    def test_normalizes_reference_breakdown_from_real_shot_matches(self) -> None:
        result = {
            "project_summary": "完整复刻对标动作",
            "reference_breakdown": {"reference_shots": []},
            "shots": [
                {
                    "reference_match": {
                        "source_time": "00:00.000–00:05.000",
                        "visual_blueprint": "人物正面站立",
                        "subject_layout": "单人居中",
                        "action_timing": "抬手后转身",
                        "camera_motion": "中景固定机位",
                        "transition": "连续动作",
                    },
                    "director_method": {"camera": "50mm 平视", "lighting_color": "冷白侧光"},
                },
                {
                    "reference_match": {
                        "source_time": "00:05.000–00:10.000",
                        "visual_blueprint": "人物侧身离场",
                        "subject_layout": "单人居中偏右",
                        "action_timing": "向右移动并出画",
                        "camera_motion": "中景轻微跟拍",
                        "transition": "动作收尾",
                    },
                    "director_method": {"camera": "50mm 平视", "lighting_color": "冷白侧光"},
                },
            ],
        }
        context = {"has_reference": True, "reference_video": {"duration_seconds": 10.0}}
        server.normalize_reference_breakdown(result, context)
        reference_shots = result["reference_breakdown"]["reference_shots"]
        self.assertEqual(len(reference_shots), 2)
        self.assertEqual(reference_shots[0]["shot_size_camera"], "中景固定机位")
        self.assertEqual(reference_shots[0]["lighting_color"], "冷白侧光")
        self.assertTrue(server.reference_ranges_cover_video(reference_shots, 10.0))

    def test_reference_coverage_accepts_action_based_segments(self) -> None:
        shots = [
            {"source_time": "00:00.000–00:04.500"},
            {"source_time": "00:04.500–00:07.000"},
            {"source_time": "00:07.000–00:10.000"},
            {"source_time": "00:10.000–00:15.033"},
        ]
        self.assertTrue(server.reference_ranges_cover_video(shots, 15.033))
        self.assertFalse(server.reference_ranges_cover_video(shots[:-1], 15.033))

    def test_normalizes_structured_copy_for_react_rendering(self) -> None:
        result = {
            "project_summary": "测试",
            "creative_brief": "简报",
            "director_application": {"composition": "门框切割", "camera": "50mm 平视"},
            "material_observations": [
                {"type": "portrait", "file": "portrait.png", "observation": "白发红衣老人"},
            ],
            "analysis_cards": [{"title": "人物", "value": {"count": 1}, "copy": "已读取"}],
            "timeline": [{"time": "00:00", "label": {"section": "前奏"}}],
            "shots": [{
                "id": "S01", "time": "00:00–00:03", "title": "开场",
                "lyrics_window": {"start": "00:00", "end": "00:03", "text": "纯音乐"},
                "prompt": "提示词", "corpus_refs": ["film-1"],
            }],
        }
        server.normalize_agent_display_fields(result)
        self.assertEqual(result["director_application"], "构图：门框切割；摄影：50mm 平视")
        self.assertEqual(result["material_observations"], ["portrait：白发红衣老人"])
        self.assertEqual(result["analysis_cards"][0]["value"], "count：1")
        self.assertEqual(result["timeline"][0]["label"], "section：前奏")
        self.assertIn("start：00:00", result["shots"][0]["lyrics_window"])

    def test_dsh_headless_receives_workspace_and_video_tool_instructions(self) -> None:
        context = {
            "title": "测试",
            "has_reference": True,
            "has_song": False,
            "has_lyrics": False,
            "has_reference_audio": False,
            "portrait_count": 1,
            "reference_video": {"duration_seconds": 3.0, "segments": [{"source_time": "00:00.000–00:03.000"}]},
            "corpus_retrieval": {"items": [{"id": "film-1"}]},
        }
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            (directory / "reference.mp4").write_bytes(b"video")
            (directory / "portrait-1.png").write_bytes(b"image")
            completed = SimpleNamespace(returncode=0, stdout='{"project_summary":"完成"}', stderr="")
            with patch.object(server, "dsh_is_available", return_value=True), \
                 patch.object(server, "run_dsh_process", return_value=completed) as run, \
                 patch.object(server, "finalize_agent_result", return_value={"provider": "DSH Headless"}):
                result = server.call_dsh_headless_agent(
                    context,
                    directory,
                    {"reference": "reference.mp4", "portrait1": "portrait-1.png"},
                )

            self.assertEqual(result["provider"], "DSH Headless")
            arguments = run.call_args.args[0]
            self.assertEqual(arguments[1:4], ["--profile", "headless", "-"])
            self.assertEqual(run.call_args.kwargs["cwd"], directory)
            task = run.call_args.kwargs["input_text"]
            self.assertIn("video_analyze", task)
            self.assertIn("不要调用 video_probe", task)
            self.assertIn("显式传 maxFrames=6", task)
            self.assertIn("禁止调用 video_ask", task)
            self.assertIn("不要再调用文件工具读取 agent-context.json", task)
            self.assertIn('"portrait1"', task)
            self.assertIn("同一个工具调用回合中并行调用 read_image", task)
            self.assertIn("shots 必须跟随真实动作阶段和切点动态分段", task)
            self.assertIsNone(run.call_args.kwargs["timeout"])
            manifest = json.loads((directory / "agent-context.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["files"]["reference"], str((directory / "reference.mp4").resolve()))
            self.assertEqual((directory / "agent-dsh-stdout.txt").read_text(encoding="utf-8"), completed.stdout)
            self.assertEqual((directory / "agent-dsh-stderr.txt").read_text(encoding="utf-8"), completed.stderr)


if __name__ == "__main__":
    unittest.main()
