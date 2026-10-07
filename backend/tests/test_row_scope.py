from app.services.row_scope import scope_parsed_rows


def _responsibility() -> dict[str, object]:
    headers = ["Regional", "UF", "Nome da base"]
    return {
        "headers": headers,
        "rows": [
            {"Regional": "SR", "UF": "SC", "Nome da base": "BNU -SC"},
            {"Regional": "SR", "UF": "RS", "Nome da base": "CQA -RS"},
            {"Regional": "PR", "UF": "PR", "Nome da base": "F MGR 02-PR"},
        ],
    }


def _source() -> dict[str, object]:
    return {
        "headers": ["Regional Origem", "PDD de saida", "Qtd"],
        "regionColumn": "Regional Origem",
        "baseColumn": "PDD de saida",
        "rows": [
            {"Regional Origem": "PR", "PDD de saida": "BNU-SC", "Qtd": 1},
            {"Regional Origem": "PR", "PDD de saida": "CQA - RS", "Qtd": 2},
            {"Regional Origem": "PR", "PDD de saida": "F MGR 02-PR", "Qtd": 3},
        ],
    }


def test_official_region_is_applied_before_regional_scoping() -> None:
    responsibility = _responsibility()
    source = _source()
    sr = scope_parsed_rows(source, {"organizational_scope": "regional", "role": "regional", "home_region": "SR"}, responsibility)
    pr = scope_parsed_rows(source, {"organizational_scope": "regional", "role": "regional", "home_region": "PR"}, responsibility)

    assert [(row["PDD de saida"], row["Regional Origem"]) for row in sr["rows"]] == [
        ("BNU-SC", "SR"),
        ("CQA - RS", "SR"),
    ]
    assert [(row["PDD de saida"], row["Regional Origem"]) for row in pr["rows"]] == [
        ("F MGR 02-PR", "PR"),
    ]


def test_matrix_sees_every_row_with_official_regional_values() -> None:
    scoped = scope_parsed_rows(_source(), {"organizational_scope": "matrix", "role": "matrix"}, _responsibility())
    assert [row["Regional Origem"] for row in scoped["rows"]] == ["SR", "SR", "PR"]
