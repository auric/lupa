# Implementation Guide: SimAST-GCN for Automatic Code Review

## Objective

Implement the SimAST-GCN algorithm to perform automatic code review. Given an original Java code fragment (method-level) and a revised version, predict whether the change should be accepted (1) or rejected (0).

## Environment Suggestion

Node.js (using JavaScript or TypeScript). Potential Libraries:
*   **Java Parser:** A library capable of parsing Java code into an Abstract Syntax Tree (AST), e.g., `java-parser`, or potentially using an external tool/service if a robust JS library isn't found. (The paper used `javalang`, a Python library, so an equivalent or alternative is needed).
*   **Machine Learning:** TensorFlow.js (`@tensorflow/tfjs-node`) for building and training the GCN, Bi-GRU, and MLP components.
*   **Embeddings:** Potentially `@tensorflow/tfjs-node` or a library for handling word embeddings if pre-trained ones are used. (Paper used `gensim` - Python).

## Inputs

1.  `original_code`: String containing the original Java method code.
2.  `revised_code`: String containing the revised Java method code.

## Output

*   A prediction score/probability (e.g., probability of acceptance) or a binary label (0 for reject, 1 for accept).

## Core Algorithm Steps (SimAST-GCN)

The algorithm processes both `original_code` and `revised_code` through the same pipeline to get vector representations (`rO`, `rR`), calculates their difference, and feeds it to a predictor.

### 1. Preprocessing (Applied to both original and revised code independently)

    a.  **Parse to AST:** Use a Java parser to convert the code string into an AST.
    b.  **Simplify AST:** This is a critical step to reduce noise and enhance structure.
        *   **Identify Nodes to Keep:**
            *   Keep all *code* nodes (representing actual code constructs like `MethodDeclaration`, `VariableDeclarator`, `ReturnStatement`, `BinaryExpression`, etc.).
            *   Keep *attribute* nodes **only if** they represent a `Declaration` or `Statement` type (e.g., `MethodDeclaration`, `LocalVariableDeclaration`). Filter out attribute nodes like `modifiers`, `parameters`, `type`, `return_type` *unless* they are needed to maintain tree structure during removal.
        *   **Remove Redundant Nodes:** Delete the identified redundant attribute nodes.
        *   **Reconnect Tree:** If a node `P` is removed, connect the children of `P` directly to the parent of `P`. (Refer to Algorithm 1 in the paper for logic).
        *   **Result:** A Simplified AST.

    c.  **Serialize Simplified AST:** Perform a depth-first traversal of the Simplified AST to get a sequence of nodes: `w = [w1, w2, ..., wn]`.

    d.  **Generate Relation Graph (Adjacency Matrix):** Create an `n x n` adjacency matrix `A` for the node sequence `w`:
        *   `A[i][j] = 1` if `i == j` (self-loop).
        *   `A[i][j] = 1` if node `wi` and node `wj` are directly connected (parent-child or potentially sibling relationship, depending on traversal/simplification details) in the *Simplified AST*.
        *   `A[i][j] = 0` otherwise.
        *   **Normalize Adjacency Matrix:** Calculate `L = A / (D + 1)`, where `D` is the diagonal degree matrix of `A`. This `L` will be used in GCN layers.

### 2. Embedding

    a.  **Word Embeddings:** Load or train word embeddings for the node types/tokens found in the serialized AST nodes. (Paper used Skip-gram via `gensim`).
        *   **Hyperparameter:** Embedding dimension `m = 300`.
    b.  **Node Sequence Embedding:** Convert the node sequence `w` into an embedding matrix `x = [x1, x2, ..., xn]`, where `xi` is the `m`-dimensional embedding vector for node `wi`. Shape: `(n, m)`.

### 3. SimAST-GCN Model Architecture

    a.  **Bi-Directional GRU (Bi-GRU):** Process the node embedding sequence `x` through a Bi-GRU layer to capture sequential context.
        *   **Input:** `x` (shape `(n, m)`).
        *   **Hyperparameter:** Hidden size = 300 (output dimension per direction will be 300, total 600 if concatenated, or potentially summed/averaged back to 300 depending on GCN input needs). Let the output be `H' = [h'1, h'2, ..., h'n]`. Shape depends on implementation (e.g., `(n, 600)` or `(n, 300)`).
        *   **Implementation:** Use TensorFlow.js `tf.layers.bidirectional` with `tf.layers.gru`.

    b.  **Graph Convolutional Network (GCN):** Apply multiple GCN layers.
        *   **Input (Layer 1):** Bi-GRU output `H'`.
        *   **Input (Subsequent Layers):** Output of the previous GCN layer `h'<sup>l-1</sup>`.
        *   **Operation (per layer `l`):**
            `h'<sup>l</sup> = LeakyReLU(L * h'<sup>l-1</sup> * W'<sup>l</sup> + b'<sup>l</sup>)`
            *   `L`: Normalized adjacency matrix (pre-calculated).
            *   `h'<sup>l-1</sup>`: Hidden states from the previous layer.
            *   `W'<sup>l</sup>`, `b'<sup>l</sup>`: Trainable weight matrix and bias vector for layer `l`.
            *   `LeakyReLU`: Activation function.
        *   **Hyperparameter:** Number of GCN layers = 3.
        *   **Implementation:** Requires implementing graph convolution using TensorFlow.js operations (matrix multiplications: `tf.matMul`).

    c.  **Attention Mechanism:** Apply retrieval-based attention on the output of the final GCN layer (`h'<sup>final</sup>`). Let `h = h'<sup>final</sup>`.
        *   Calculate attention scores: `βi = Σ<sup>n</sup><sub>t=1</sub> h<sup>T</sup><sub>t</sub> * hi` (dot product between each node representation and the sum/context representation). *Correction based on paper formula: `βi = u<sup>T</sup> * tanh(W_att * hi + b_att)` might be more standard, or simply `βi = Σ<sup>n</sup><sub>t=1</sub> h<sup>T</sup><sub>t</sub> hi` as written, which compares each node `hi` to the sum of all node vectors `Σh<sub>t</sub>`. Let's assume the paper meant `βi = h<sup>T</sup><sub>context</sub> * hi` where `h<sub>context</sub>` is some learned context vector or an aggregation like sum/mean of all `h<sub>t</sub>`. Given Eq 8, it seems `βi = (Σ<sup>n</sup><sub>t=1</sub> h<sub>t</sub>)<sup>T</sup> * hi` might be the intended interpretation, though unusual. *Alternatively and more standardly*, it might mean `βi = h<sub>i</sub><sup>T</sup> * W_att * h<sub>context</sub>` or similar. Clarification might be needed, but let's proceed with the paper's Eq 8 structure interpreted as `βi = (Σ<sup>n</sup><sub>t=1</sub> h<sub>t</sub>)<sup>T</sup> * hi` for now.*
        *   Calculate attention weights: `αi = exp(βi) / Σ<sup>n</sup><sub>k=1</sub> exp(βk)` (Softmax over scores).
        *   Calculate final representation: `r = Σ<sup>n</sup><sub>i=1</sub> αi * hi` (Weighted sum of node representations). `r` is the final vector representation for the code fragment.

### 4. Prediction

    a.  **Get Representations:** Obtain `rO` for `original_code` and `rR` for `revised_code` using steps 1-3.
    b.  **Calculate Difference:** `r_diff = rO - rR`.
    c.  **MLP Classifier:** Feed the difference vector `r_diff` into a simple Multi-Layer Perceptron (MLP).
        *   Example: A single dense layer with Softmax activation for binary classification.
        *   `y_pred = softmax(W_mlp * r_diff + b_mlp)`
        *   **Output:** Probabilities for reject (class 0) and accept (class 1).

### 5. Training

    a.  **Loss Function:** Weighted Cross-Entropy Loss to handle class imbalance (common in code review datasets).
        *   `L = - Σ [ w_class0 * y_true_0 * log(y_pred_0) + w_class1 * y_true_1 * log(y_pred_1) ] + λ ||θ||²`
        *   `w_class0`, `w_class1`: Weights for each class (higher weight for the minority class, e.g., 'rejected'). Calculate based on dataset statistics or use 'balanced' mode if library supports it.
        *   `λ`: L2 regularization coefficient. **Hyperparameter:** `λ = 10<sup>-5</sup>`.
        *   `θ`: All trainable parameters.
    b.  **Optimizer:** Adam.
        *   **Hyperparameter:** Learning rate = 10<sup>-3</sup>.
    c.  **Batching:** Train using mini-batches.
        *   **Hyperparameter:** Batch size = 128.
    d.  **Initialization:** Initialize weights (`W`, `b`) using a uniform distribution.

## Key Hyperparameters Summary

*   Embedding Dimension: 300
*   Bi-GRU Hidden Size: 300
*   GCN Layers: 3
*   Optimizer: Adam
*   Learning Rate: 1e-3
*   L2 Regularization (λ): 1e-5
*   Batch Size: 128
*   Loss: Weighted Cross-Entropy (adjust weights for imbalance)

## Implementation Notes for Code Agent

*   Focus on implementing the **AST Simplification** logic accurately based on the paper's description (Algorithm 1 / Section 3.1.1).
*   Ensure correct implementation of the **GCN layer formula** (Eq 5, 6) using sparse matrix multiplication if possible (for `L`) or dense multiplication in TensorFlow.js.
*   Implement the **Attention mechanism** (Eq 8, 9, 10) carefully. Note the potential ambiguity in Eq 8's context vector, consider `Σh<sub>t</sub>` as the context.
*   Use TensorFlow.js for the neural network components (Bi-GRU, GCN layers as custom ops/layers, Attention, MLP).
*   Handle the input processing (parsing, simplification, serialization, graph generation) potentially outside the core TF.js model graph, preparing tensors as input.
*   Remember to apply the entire pipeline (Steps 1-3) to *both* the original and revised code snippets before calculating the difference for prediction (Step 4).