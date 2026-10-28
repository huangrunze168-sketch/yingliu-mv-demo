import importlib.util
import pathlib
import unittest


SERVER_PATH = pathlib.Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("yingliu_demo_server_generation_contract", SERVER_PATH)
assert SPEC and SPEC.loader
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class GenerationContractTests(unittest.TestCase):
    def replacement_state(self) -> dict:
        return {
            "requirements": "将画面中的人物替换为人物参考图，其他动作、运镜和特效保持不变。",
            "files": {
                "portrait": "portrait.jpg",
                "reference": "reference.mp4",
                "song": "song.wav",
            },
            "generation_plan": {
                "shots": [{
                    "id": "SH01",
                    "start": 0,
                    "end": 5,
                    "prompt": "保留原视频的动作、运镜、光影和特效。",
                    "negative_prompt": "字幕、水印",
                }],
            },
        }

    def test_shot_plan_cannot_drop_original_requirements(self) -> None:
        state = self.replacement_state()
        prompt = server.build_generation_prompt(state)
        self.assertIn(state["requirements"], prompt)
        self.assertIn("人物替换硬约束", prompt)
        self.assertIn("禁止保留或复刻原片人物", prompt)
        self.assertLess(prompt.index(state["requirements"]), prompt.index("SH01"))

    def test_segment_prompt_keeps_replacement_contract(self) -> None:
        state = self.replacement_state()
        prompt = server.prompt_for_window(state, 0, 5)
        self.assertIn(state["requirements"], prompt)
        self.assertIn("人物替换硬约束", prompt)
        self.assertIn("保留原视频的动作、运镜、光影和特效", prompt)

    def test_reference_only_does_not_invent_character_replacement(self) -> None:
        state = {
            "requirements": "按对标视频复刻镜头节奏。",
            "files": {"reference": "reference.mp4"},
        }
        contract = server.generation_execution_contract(state)
        self.assertIn("对标视频执行约束", contract)
        self.assertNotIn("人物替换硬约束", contract)

    def test_paid_request_is_blocked_when_references_or_contract_are_missing(self) -> None:
        state = self.replacement_state()
        valid_prompt = server.build_generation_prompt(state)
        with self.assertRaisesRegex(ValueError, "同时提交人物参考图和对标视频"):
            server.validate_generation_payload_contract(state, {
                "prompt": valid_prompt,
                "referenceImages": [],
                "referenceVideos": ["https://assets.example/reference.mp4"],
            })
        with self.assertRaisesRegex(ValueError, "缺少身份替换硬约束"):
            server.validate_generation_payload_contract(state, {
                "prompt": "保留原视频内容",
                "referenceImages": ["https://assets.example/portrait.jpg"],
                "referenceVideos": ["https://assets.example/reference.mp4"],
            })

    def test_valid_replacement_payload_passes_preflight(self) -> None:
        state = self.replacement_state()
        references = server.ModelReferences(
            images=("https://assets.example/portrait.jpg",),
            videos=("https://assets.example/reference.mp4",),
            audios=("https://assets.example/song.wav",),
        )
        adapter = server.video_model_adapter("minimax-h3-768p")
        payload = adapter.build_payload(server.build_generation_prompt(state), "16:9", 15, references)
        server.validate_generation_payload_contract(state, payload)
        self.assertEqual(payload["referenceImages"], ["https://assets.example/portrait.jpg"])
        self.assertEqual(payload["referenceVideos"], ["https://assets.example/reference.mp4"])


if __name__ == "__main__":
    unittest.main()
