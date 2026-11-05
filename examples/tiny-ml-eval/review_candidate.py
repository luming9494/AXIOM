"""WP-02 narrow structural policy. Parse source without importing candidate code.

Only an nn.Linear baseline or an nn.Sequential of Linear/ReLU/Tanh is allowed.
This is intentionally not a general Python security sandbox.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path


def review_source(source):
    if len(source.encode("utf-8")) > 8192:
        raise ValueError("Model source exceeds 8 KiB")
    tree = ast.parse(source)
    nodes = list(tree.body)
    if nodes and isinstance(nodes[0], ast.Expr) and isinstance(nodes[0].value, ast.Constant) and isinstance(nodes[0].value.value, str):
        nodes.pop(0)
    if len(nodes) != 2:
        raise ValueError("Only 'from torch import nn' and build_model() are allowed")
    imp, function = nodes
    if not isinstance(imp, ast.ImportFrom) or imp.module != "torch" or imp.level or len(imp.names) != 1 or imp.names[0].name != "nn" or imp.names[0].asname:
        raise ValueError("Only 'from torch import nn' is allowed")
    if not isinstance(function, ast.FunctionDef) or function.name != "build_model" or function.decorator_list or function.returns:
        raise ValueError("Expected undecorated build_model()")
    args = function.args
    if args.args or args.posonlyargs or args.kwonlyargs or args.vararg or args.kwarg or args.defaults or args.kw_defaults:
        raise ValueError("build_model() takes no arguments")
    if len(function.body) != 1 or not isinstance(function.body[0], ast.Return):
        raise ValueError("build_model must contain only one return statement")

    def call_name(node):
        if not isinstance(node, ast.Call) or node.keywords or not isinstance(node.func, ast.Attribute) or not isinstance(node.func.value, ast.Name) or node.func.value.id != "nn":
            raise ValueError("Only direct nn layer calls without keyword arguments are allowed")
        return node.func.attr

    expression = function.body[0].value
    name = call_name(expression)
    layers = expression.args if name == "Sequential" else [expression]
    if name != "Sequential" and name != "Linear":
        raise ValueError("Expected nn.Linear or nn.Sequential")
    if not 1 <= len(layers) <= 7:
        raise ValueError("Expected 1 to 7 layers")
    width, linear_count, activation_count, parameters = 2, 0, 0, 0
    for layer in layers:
        layer_name = call_name(layer)
        if layer_name == "Linear":
            if len(layer.args) != 2 or any(not isinstance(arg, ast.Constant) or type(arg.value) is not int or not 1 <= arg.value <= 64 for arg in layer.args):
                raise ValueError("Linear requires two literal dimensions in [1, 64]")
            inputs, outputs = (arg.value for arg in layer.args)
            if inputs != width:
                raise ValueError("Layer dimensions do not connect")
            parameters += inputs * outputs + outputs
            width = outputs
            linear_count += 1
        elif layer_name in {"ReLU", "Tanh"} and not layer.args:
            activation_count += 1
        else:
            raise ValueError("Only Linear, ReLU and Tanh layers are allowed")
    if width != 2 or parameters > 1024:
        raise ValueError("Model must output 2 logits and use at most 1024 parameters")
    return {
        "status": "approved_by_narrow_policy", "input_features": 2, "output_features": width,
        "kind": "mlp" if linear_count >= 2 and activation_count >= 1 else "linear",
        "linear_layers": linear_count, "activations": activation_count, "parameters": parameters,
        "model_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    args = parser.parse_args()
    try:
        # Preserve exact source bytes in the reported hash, including CRLF.
        source = (Path(args.candidate) / "model.py").read_bytes().decode("utf-8")
        print(json.dumps(review_source(source)))
    except (ValueError, OSError, SyntaxError) as error:
        parser.exit(1, f"Candidate policy rejected: {error}\n")


if __name__ == "__main__":
    main()
