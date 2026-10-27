import unittest

from film_corpus import GENERAL_CORPUS, retrieve_film_corpus


METHODS = {
    "composition": "强负空间和前中后景层次",
    "camera": "35mm 缓慢推进与稳定横移",
    "lighting": "方向明确的逆光和轮廓光",
    "color": "冷灰环境中保留自然肤色",
    "blocking": "人物通过视线和位置变化表达关系",
    "rhythm": "动作完成后再切镜并保留停顿",
    "avoid": "避免无目的手持和杂乱综合色",
}


class FilmCorpusTest(unittest.TestCase):
    def test_retrieval_covers_all_director_categories(self) -> None:
        result = retrieve_film_corpus("测试导演", METHODS, "舞台演唱，人群，口型，跟拍")
        self.assertEqual(set(result["coverage"]), set(METHODS))
        self.assertEqual(result["stats"]["director_entries"], 7)
        self.assertEqual(result["stats"]["returned"], 11)

    def test_stage_query_retrieves_stage_or_lip_sync(self) -> None:
        result = retrieve_film_corpus("测试导演", METHODS, "乡村舞台 DJ 演唱，观众群像，粤语口型")
        general_ids = {item["id"] for item in result["items"] if item["director"] == "通用"}
        self.assertTrue({"general.stage.crowd", "general.mv.lip-sync"} & general_ids)

    def test_ids_are_stable_and_internal(self) -> None:
        first = retrieve_film_corpus("测试导演", METHODS, "构图")
        second = retrieve_film_corpus("测试导演", METHODS, "构图")
        self.assertEqual([item["id"] for item in first["items"]], [item["id"] for item in second["items"]])
        self.assertTrue(all(item["id"] not in item["text"] for item in first["items"]))
        self.assertGreaterEqual(len(GENERAL_CORPUS), 6)


if __name__ == "__main__":
    unittest.main()
