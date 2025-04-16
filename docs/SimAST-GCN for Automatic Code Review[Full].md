# Turn Tree into Graph: Automatic Code Review via Simplified AST Driven Graph Convolutional Network

**Bingting Wu<sup>a</sup>, Bin Liang<sup>b,*</sup>, and Xiaofang Zhang<sup>a,*</sup>**

<sup>a</sup> School of Computer Science and Technology, Soochow University, Suzhou, China
<sup>b</sup> Department of Computer Science, Harbin Institute of Technology, Shenzhen, China

*Corresponding author.*
*   20204227028@stu.suda.edu.cn (B. Wu); bin.liang@stu.hit.edu.cn (B. Liang); xfzhang@suda.edu.cn (X. Zhang)
*   ORCID(S):

---

## ARTICLE INFO

**Keywords:**
*   Automatic Code Review
*   Deep Learning
*   Abstract Syntax Tree
*   Graph Neural Networks

---

## ABSTRACT

Automatic code review (ACR), which can relieve the costs of manual inspection, is an indispensable and essential task in software engineering. To deal with ACR, existing work is to serialize the abstract syntax tree (AST). However, making sense of the whole AST with sequence encoding approach is a daunting task, mostly due to some redundant nodes in AST hinder the transmission of node information. Not to mention that the serialized representation is inadequate to grasp the information of tree structure in AST. In this paper, we first present a new large-scale Apache Automatic Code Review (AACR) dataset for ACR task since there is still no publicly available dataset in this task. The release of this dataset would push forward the research in this field. Based on it, we propose a novel Simplified AST based Graph Convolutional Network (SimAST-GCN) to deal with ACR task. Concretely, to improve the efficiency of node information dissemination, we first simplify the AST of code by deleting the redundant nodes that do not contain connection attributes, and thus deriving a Simplified AST. Then, we construct a relation graph for each code based on the Simplified AST to properly embody the relations among code fragments of the tree structure into the graph. Subsequently, in the light of the merit of graph structure, we explore a graph convolution networks architecture that follows an attention mechanism to leverage the crucial implications of code fragments to derive code representations. Finally, we exploit a simple but effective subtraction operation in the representations between the original and revised code, enabling the revised difference to be preferably learned for deciding the results of ACR. Experimental results on the AACR dataset illustrate that our proposed model outperforms the state-of-the-art methods.

---

## 1. Introduction

Code review is the act of consciously and systematically convening programmers to check each other's code for mistakes, and has been repeatedly shown to accelerate and streamline the process of software development. Hence, it also incurs considerable human resources [1], making it impossible to expand code review on a large scale. Therefore, many researchers are committed to automatic code review (ACR). For ACR, we first provide the model with the original code and the revised code, and then the model provides us with suggestions on whether this modification is acceptable.

Traditional approaches are limited to deal with the main challenge of code review: understanding the code [2]. Therefore, researchers can only improve efficiency from other aspects of code review, such as recommending suitable reviewers [3, 4, 5] and using static analysis tools [6, 7, 8]. However, with the development of deep learning, we can understand the code by modeling the source code, thereby effectively solving the main challenges in automatic code review.

Recent work [9, 10] has shown that deep learning methods perform better in capturing the syntactical and semantic information of the source code, enabling suitable code review suggestions. Among them, Shi [9] proposes a method called Deep Automatic Code reviEw (DACE), which uses long short-term memory (LSTM) [11] and convolutional neural network (CNN) [12] to capture the semantic and syntactical information, respectively. Due to the characteristics of ACR, the model needs to compare the original code and the revised code. They also design a pairwise recursive autoencoder to compare the code.

In most previous research efforts, they divide the code according to the delimiter to ensure that the syntactical information of the code can be preserved. However, such delimiter-based models still limit in that splitting the code according to the delimiter does not effectively represent the structural information of the code. This is because of the differences between programming languages and natural languages. In natural language, it is usually sequential comprehension. But in a programming language, it needs to be understood under the logical order of the abstract syntax tree (AST). For example, the programmer may divide the code into lines because the code is too long, but this does not mean that the syntax of the code has changed.

In the field of code representation, moreover, there are some AST-based methods. These methods mostly serialize the AST into a sequence of nodes. In the subsequent processing, various network models can be applied to improve the performance of code representation. Although these methods use some structural information in the AST, they do not make full use of the structural information at the model level.

We thus explore a novel solution to represent the code fragments: obtaining a more concise and efficient code graph representation by simplifying the AST and using graph convolution to handle the associated information between nodes. Based on the idea, we propose a Simplified AST based Graph Convolutional Network (SimAST-GCN) model to leverage the semantic dependencies of the code fragments. Here, the semantic and syntactical information from neighbors of each node are aggregated to derive the code graph embeddings, so as to extract the semantics for representing the code fragments well. To our knowledge, this is the first study to deploy the graph structure for leveraging the node connection information in the AST for the code review task. Further, there is no public dataset for the code review task. As such, to advance and facilitate research in the field of ACR, we present a new Apache Automatic Code Review (AACR) dataset. The main contributions of our work can be summarized as follows:

*   We provide a large-scale Apache Automatic Code Review dataset (AACR), since there is no public dataset available for ACR.
*   A Simplified AST based Graph Convolutional Network is proposed to extract syntactical and semantic information from source code fragments.
*   Experimental results on the AACR dataset show that the proposed model achieves significantly better results than state-of-the-art baseline methods.

The rest of this paper is organized as follows. Section 2 introduces the background. Section 3 describes our approach. Section 4 provides our experimental design. Section 5 presents the experimental results and analyzes them. Section 6 presents several related works. Finally, Section 7 concludes our work.

---

## 2. Background

**Figure 1:** Traditional code review process.
*(Image omitted - Description: Flowchart showing developer submitting original/revised files, reviewer accepting/rejecting, leading to code base)*

**Figure 2:** Example of source code.
*(Image omitted - Description: Simple Java `add` method taking input using Scanner)*

### 2.1. Code Review

The general process of traditional code review is shown in Figure 1. When a developer completes and submits the code implementation for specific requirements, the system will arrange a suitable reviewer who needs to compare the differences between the original file and the revised file to verify whether the code meets the requirements. If there is no problem, the code will be added to the code base; otherwise, the reviewer will ask the developer to revise the code.

Traditional approaches use static analysis tools to assist with code review. For example, Checkstyle¹ covers coding style-related issues, PMD² checks class design issues and questionable coding practices, and FindBugs³ [13] detects potential bugs in the code. However, traditional static analysis tools cannot understand the code. They only judge whether there is a problem with the code based on predefined patterns.

To solve the ACR task with a deep learning method, the model first extracts as many features as possible from the original file and the revised file, and encode these features as vector representations. Then, the model uses different network structures to enhance these features to maximize the characteristics of the source code. Finally, it is necessary to design a suitable model or method to calculate the distance between the original file and the revised file, and generate code review recommendations based on the difference.

### 2.2. Abstract Syntax Tree

An abstract syntax tree (AST) is a tree designed to represent the abstract syntactic structure of source code [14]. For example, Figure 2 shows an example of source code, and Figure 3(a) shows the AST extracted from that source code. AST has been widely used by programming languages and software engineering tools. For example, it has a wide range of applications in source code representation [15, 16], defect prediction [17], and other fields. Each node of an AST corresponds to a construct or symbol in the source code. Firstly, unlike ordinary source code, AST is abstract and does not contain all the details, such as separators and punctuation. Secondly, AST contains richer structural and semantic information, which is very suitable for representing source code.

Here, we do not directly use the original AST information. Since after the program is parsed into an AST, its node size will increase significantly, which hampers the performance of the graph network. Therefore, we simplify the AST to improve the performance of the entire model.

¹ https://checkstyle.sourceforge.io
² https://pmd.github.io
³ http://findbugs.sourceforge.net

### 2.3. Tree-based Neural Network

Recently, many researchers have proposed Tree-Based Neural Networks (TBNNs) that use ASTs directly as model inputs. Given a tree, TBNNs typically use a recursive approach, aggregating information from leaf nodes upward in layers to obtain a vector representation of the source code. The most representative model of the code representation is AST-based Neural Network (ASTNN) [15].

In ASTNN, they parse the code fragment into the AST and use the preorder traversal algorithm to split the AST into a sequence of statement trees (ST-trees, that is, a tree composed of the statement node as the root and the AST node corresponding to the statement). Then, they design a Statement Encoder module to encode all ST-trees into vectors e₁, ..., eN. For each ST-tree t, let n denotes a non-leaf node, and C denotes the number of its children nodes. With the pre-trained embedding matrix We ∈ R|V|×d where V is the vocabulary size and d is the embedding dimension of nodes, the vector of node n can be obtained by:

`vn = WeT xn` (1)

where xn is the one-hot representation of symbol n and vn is the embedding. Next, the representation of node n is computed by the following equation:

`h = σ(WT vn + Σ(hi) + bn)` where `i∈[1,C]` (2)

where Wr ∈ Rd×k is the weight matrix with encoding dimension k, hi is the hidden state for each children i, bn is a bias term, σ is the activation function and h is the updated hidden state. The final representation of the ST-tree is computed by:

`ei = [max(h_i1), ..., max(h_ik)], i = 1, ..., N` (3)

where N is the number of nodes in the ST-tree. Then, ASTNN uses Bidirectional Gated Recurrent Unit (Bi-GRU) [18], to model the characteristics of the statements. The hidden states of Bi-GRU are sampled into a single vector by pooling. Such a vector captures the characteristics of source code [19], [20] and can serve as a neural source code representation.

**Figure 3:** Example of preprocessing source code based on AST. The nodes framed by dashed lines are later removed. The AST is extracted from the source code shown in Figure 2.
*(Image omitted - (a) Full Abstract Syntax Tree (b) Simplified Abstract Syntax Tree showing removal of nodes like 'modifiers', 'parameters', some 'LocalVariableDeclaration' nodes)*

### 2.4. Motivation

As illustrated in the previous sections, the structural information of code, like AST, Control Flow Graph (CFG) [21], Data Flow Graph (DFG) [22], have been widely used in many tasks. We think that it's meaningful to use the structural information in ACR task.

For token-based methods and delimiter-based methods, the performance is under the expectation in many tasks. Their approaches are to divide the code into tokens or lines according to the space or delimiter. There is no doubt that these pre-processing operations abandon the structural information. However, in the code representation, the structural information is much more important than that in nature language process. Hence, it is a little late for us to use the AST information in ACR task.

In addition to introducing AST structure information into ACR, we also made some optimizations and improvements. In many code representation methods, we noticed that many researchers [15] believe that the large number of AST nodes has a negative effect on the model.

In order to solve this problem, we manually checked all the node types generated by AST, and tried to filter the generated nodes with simple rules. Attempt to greatly reduce the number of automatically generated nodes without affecting the overall structure and semantic information of the AST, so as to obtain lightweight and effective structural information.

Similarly, we also found that in the field of code representation, there are still some shortcomings in the use of AST's tree structure information. Researchers usually serialize the tree structure into a sequence of nodes, which damages the overall information expression to some extent. Therefore, in this article, we also propose the use of the latest graph convolution operation and attention mechanism to better capture code information from the tree structure.

---

## 3. Proposed Approach

**Figure 4:** General framework of SimAST-GCN. The blue and khaki nodes in the AST correspond to the nodes in Figure 3. The white nodes are the undrawn parts.
*(Image omitted - Flowchart: 1. Input (Original/Revised code) -> AST -> Simplified AST -> Embedding Module -> Node Sequence & Relation Graph. 2. Bi-GRU -> GCN Layers -> Attention -> Embeddings/Hidden representations. 3. Original/Revised representations -> Difference -> MLP -> Prediction Output)*

We introduce our approach (SimAST-GCN) in this section. As shown in Figure 4, the architecture of the proposed SimAST-GCN framework contains three main components. First, the Node Sequence and Relation Graph Generation module simplifies the AST, as illustrated in Figure 3, and generates the corresponding adjacency matrix and node sequence based on the Simplified AST. Second, the proposed SimAST-GCN obtains the word embeddings of the node sequence and uses a Bidirectional Gated Recurrent Unit (Bi-GRU) to model the naturalness of the statements. It then employs a Graph Convolution Network (GCN) to fuse the node relation graph and the hidden status. Finally, retrieval-based attention is employed to derive the code representation. Third, a prediction is made by calculating the differences in the code representations to predict the final result.

### 3.1. Node Sequence and Relation Graph Generation

#### 3.1.1. Simplifying AST

First, we use the existing syntax analysis tools to parse the source code fragments into the corresponding ASTs. For each AST, we delete the redundant nodes and reconstruct node connections of the entire AST to ensure the integrity of the tree structure.

Given an AST T and the AST attribute nodes S (attribute nodes, the blue nodes in Figure 3). First, we filter attribute nodes and retain nodes with strong semantic information. We assume that if the attribute nodes contain a `Declaration` or `Statement`, then these attribute nodes contain connection information. For example, in Figure 3(a), `MethodDeclaration` defines a method, all nodes under the method belong to this node, while the node `modifiers` indicates that the node `static` is a modifier, and reduces the strength of the connection between the node `static` and `MethodDeclaration`. Therefore, we remove these redundant nodes to reduce the number of node sequences and increase the strength of the connection between each node.

If we simply remove the redundant nodes in the AST tree, it will split the entire AST. To maintain the integrity of the whole tree, we need to reconnect the split AST. For example, in Figure 3(a), the nodes framed by dashed lines are removed, and finally a Simplified AST is generated, as shown in Figure 3(b). The procedure for simplifying the AST is depicted in Algorithm 1. In general, if the node in the original AST is deleted, we connect the child node of the deleted node to its parent node.

**Algorithm 1:** Procedure for simplifying the AST
**Input:** The root of AST, R; the source code fragment, C; the attribute node, S.
**Output:** The Simplified AST.
1: Let FS = [].
2: for each node ∈ S do
3: if Declaration ∈ node or Statement ∈ node then
4: FS = FS + node
5: function SIMPLIFYAST(R, C, FS)
6: Let children = [ ].
7: for each node ∈ R[child] do
8: if node ∈ C or node ∈ FS then
9: children = children + node
10: else
11: children = children + node[child]
12: SimplifyAST(node, C, FS)
13: R[child] = children
14: SIMPLIFYAST(R, C, FS)
15: return R


#### 3.1.2. Generate Node Sequence and Relation Graph over Simplified AST

After obtaining the Simplified AST, we use the depth-first traversal algorithm to serialize the Simplified AST into Node Sequences. For example, if the size of the AST is n, then we derive a node sequence w = [w1, w2, ..., wn]. Inspired by previous GCN-based approach [23], we produce a node relation graph for each code fragment over the simplified AST:

`Aij = { 1 if i = j or wi, wj are directly connected`
`      { 0 otherwise` (4)

Then, an adjacency matrix A ∈ R<sup>n×n</sup> is derived via the simplified AST of the source code fragments.

### 3.2. SimAST-GCN

#### 3.2.1. Embedding Model

In our proposed model SimAST-GCN, we use the gensim [24] library to train the embeddings of symbols to get the distributed representations of the words in the AST. Thus, we can get the embedding lookup table V ∈ R<sup>m×|N|</sup> according to the word index, where m is the embedding size (the dimension of each word) and |N| is the number of all words after deduplication (vocabulary size). Then, given a node sequence with n nodes, we can get the corresponding embedding matrix x = [x1, x2, ..., xn], where xi ∈ R<sup>m</sup> is the word embedding.

#### 3.2.2. Graph Convolutional Network

In our model SimAST-GCN, our GCN module takes the node relation graph and the corresponding node representations as input. Each node representation in the l-th GCN layer is updated by aggregating the information from their neighborhoods, the calculation formula is:

`h'i = LeakyReLU(Lh'<sup>l−1</sup>W' + b')` (5)

where h'<sup>l−1</sup> is the hidden representation generated from the preceding GCN layer. L is a normalized symmetric of a node relation adjacency matrix:

`L = A / (D + 1)` (6)

where `D = Σ<sup>n</sup><sub>j=1</sub> Aij` is the degree of Ai. The original node representations for the GCN layers are the hidden representations generated by the Bi-GRU layers, which using the previous embedding matrix x as the 1-st GCN layer input:

`H' = {h'1, h'2, ..., h'n} = Bi-GRU(x)` (7)

Finally, we can capture the representations h of the GCN layers successfully. Subsequently, we use the retrieval-based attention mechanism [23] to capture significant sentiment features from the context representations for the source code:

`βi = Σ<sup>n</sup><sub>t=1</sub> h<sup>T</sup><sub>t</sub> h<sub>i</sub>` (8)

`αi = exp(βi) / Σ<sup>n</sup><sub>k=1</sub> exp(βk)` (9)

where h<sup>T</sup><sub>t</sub> is the transposition of the hidden status of the t-th node, and hi is the graph hidden representation of the i-th node. Hence, the final representation of the source code fragment is formulated as follows:

`r = Σ<sup>n</sup><sub>i=1</sub> αi h'i` (10)

### 3.3. Prediction

The above content is the operation for one code fragment. The ACR process needs to compare the two source code fragments (the original file s<sup>O</sup> and the revised file s<sup>R</sup>) and give a judgment—that is, whether it passes the code review. Therefore, after we obtain the corresponding representations r<sup>O</sup> and r<sup>R</sup>, we need to calculate the distance between them:

`r = r<sup>O</sup> - r<sup>R</sup>` (11)

`y = softmax(Wr + b)` (12)

where softmax() is the softmax function.

The target to train the classifiers is to minimize the weighted cross entropy loss between the predicted and the true distributions:

`L = - Σ<sup>S</sup><sub>i=1</sub> (w<sup>o</sup> y<sub>i</sub> log p<sub>i</sub> + w<sup>r</sup>(1−y<sub>i</sub>)log(1−p<sub>i</sub>)) + λ ||θ||<sup>2</sup>` (13)

where S denotes the number of training samples, w<sup>o</sup> is the weight of incorrectly predicting a rejected change, w<sup>r</sup> is the weight of incorrectly predicting an approved change. These two terms provide the opportunity to handle an imbalanced label distribution. λ is the weight of the L₂ regularization term. θ denotes all trainable parameters.

---

## 4. Experimental design

This section introduces the process of the experiment, including the repository selection and the data construction, baseline setting, evaluation metrics and experimental setting.

**Table 1:** Statistics of the AACR dataset.
| Repository      | #methods | #rejected | reject rate |
|-----------------|----------|-----------|-------------|
| accumulo        | 12,704   | 2,883     | 23%         |
| ambari          | 5,313    | 542       | 10%         |
| cloudstack      | 9,942    | 6,032     | 61%         |
| commons-lang    | 6,176    | 5634      | 91%         |
| flink           | 23,792   | 16,172    | 68%         |
| incubator-point | 7,759    | 1,001     | 13%         |
| kafka           | 24,912   | 8,888     | 36%         |
| lucene-solr     | 6,785    | 2,886     | 43%         |
| shardingsphere  | 12,254   | 676       | 6%          |

### 4.1. Dataset Construction

We selected 9 projects from Github belonging to the Apache Foundation because the Apache Foundation is a widely used code review source. Six of them (commons-lang, flink, incubator-point, kafka, lucene-solr, shardingsphere) were chosen because they have over 2000 stars. The remaining projects (accumulo, ambari, cloudstack) were selected by [9]. The language of all the projects is Java.

For data processing, we extracted all issues belonging to these projects from 2018 to 2020. Among these issues, many do not involve code submission, but only provide feedback, so we need to choose according to the issue type. After manually analyzing hundreds of issue types, we finally chose the types `PullRequestEvent` and `PullRequestReviewCommentEvent`. Because only these two types of issues have revised code, it can be judged whether the code has passed the review by inspecting whether the code has been added to the code base.

In many practical cases, we can easily extract the original code and revised code from the issue, but because these codes are usually contained in many files, it is difficult for us to use them directly as the input of the network. Therefore, we assume that all of the changes are independent and identically distributed, so there is no connection between these changes, and if a file contains many changed methods, we can split these methods independently as inputs.

Further, if we add a new method or delete a whole method, half of the input data is empty. So we discard these data because they cannot be fed into the network. That is, we only consider the case where the code has been changed. In addition, considering that the submitted data may be too large, we subdivide the code submitted each time into the method level for subsequent experiments.

After processing the data, each piece of data comprises three parts: the original code fragment, the revised code fragment, and the label. The original code fragment and the revised code fragment are both method-level Java programs. The label uses 0 and 1 to represent rejection and acceptance. The basic statistics of the AACR are summarized in Table 1.

In this paper, the rate of the rejection between 6% and 91% means that there is class imbalance during model training and it will lead to poor performance, so we set the `class_weight` parameter to `balance` in our model.

### 4.2. Comparison Models

In this paper, we compared our proposed model (SimAST-GCN) with three other models in the ACR task. These models use different methods (including delimiter-based method, token-based method, tree-based method) to obtain the code features. The baseline models are as follows:

*   **DACE** [9] divides the code according to the delimiter and designs a pairwise recursive autoencoder to compare the code.
*   **TBRNN** serializes the AST into tokens and uses an RNN to capture the syntactic and semantic information.
*   **ASTNN** [15] splits large ASTs into a sequence of small statement trees and calculates the representation distance to compare the code.

In addition, we considered variants of our proposed SimAST-GCN.

*   **ASTGCN** is our proposed model without the Simplified AST module.
*   **SimAST** is our proposed model without the GCN module.
*   **SAGCN-C** is our proposed model, but where it connect the representations to compare codes rather than calculating the distance.

In order to ensure the fairness of the experiment and the stability of the results, we ran all the methods on the new AACR dataset, and each experiment was repeated 30 times.

### 4.3. Evaluation

#### 4.3.1. Metrics for ACR evaluation

Since the automatic code review can be formulated as a binary classification problem (accept or reject) [9], we choose the commonly-used Accuracy, F1-measure (F1), Area under the receiver operating characteristic curve (AUC) as evaluation metrics. In addition, considering the unbalanced data distribution in the AACR dataset, we also added another evaluation metric Matthews correlation coefficient (MCC) to better evaluate the performance and efficiency of the model.

The value range of AUC is [0,1]. When the AUC value is 1, it means that the predicted value is consistent with the correct value. When the AUC value is 0.5, it is equivalent to random selection. When the AUC value is less than 0.5, it means that it is worse than random selection.
The detailed definitions of Accuracy is as follows:

`Accuracy = (TP + TN) / (TP + TN + FP + FN)` (14)

where TP, FP, FN, and TN represent True Positives, False Positives, False Negatives, and True Negatives, respectively. The Accuracy is the ratio of the number of correctly predicted samples to the total number of predicted samples.
The calculation formula of F1 is as follows:

`Precision = TP / (TP + FP)` (15)

`Recall = TP / (TP + FN)` (16)

`F1 = 2 * (Precision * Recall) / (Precision + Recall)` (17)

The F1 score is the harmonic mean of the precision and recall. The value range of F1 is [0,1], which indicates the result is between the zero precision (or recall) value and the perfect recall and precision.
The calculation formula of MCC is:

`MCC = (TP × TN - FP × FN) / √((TP + FP)(TP + FN)(TN + FP)(TN + FN))` (18)

The value range of MCC is [-1,1], indicating the prediction is totally wrong and the predicted result is consistent with the real situation, separately.

#### 4.3.2. Significance analysis (Win/Tie/Loss indicator)

In this paper, we used the Win/Tie/Loss indicator to compare further the performance difference between SimAST-GCN and the baseline models, which is widely used in software fields [25],[26]. We repeated the experiment 30 times for all models. Then we applied two data analysis methods (Wilcoxon signed-rank test and Cliff's delta test) to analyze the performance of SimAST-GCN and other methods.

The Wilcoxon signed-rank test is commonly used for pairwise comparison. It is a non-parametric statistical hypothesis test used to determine whether the two populations of matched samples have the same distribution. Different from the Student's t-test, the Wilcoxon signed-rank test does not assume that the data are normally distributed. It is more statistically detectable for different datasets than the Student's t-test, and it is more likely to give statistically significant results. The p value is used to determine whether the difference between the two populations of a matched samples is significant (p value < 0.05) or not.

The Cliff's delta test [27] is a non-parametric effect size test, which is a supplementary analysis of the Wilcoxon signed-rank test in this paper. It measures the difference between two populations of comparison samples in the form of numerical value. Table 2 shows the mappings between Cliff's delta values (|δ|) and their effective levels.

**Table 2:** Mappings between the Cliff's delta values(|δ|) and their effective levels
| Cliff's delta      | Effective levels |
|--------------------|------------------|
| \|δ\| < 0.147       | Negligible       |
| 0.147 ≤ \|δ\| < 0.33 | Small            |
| 0.33 ≤ \|δ\| < 0.474  | Medium           |
| 0.474 ≤ \|δ\|       | Large            |

Specifically, for SimAST-GCN and a baseline model M, the Win/Tie/Loss indicator between them on ACR task is calculated as follows:

*   **Win:** The result of SimAST-GCN outperforms M, if the p value less than 0.05, and the effective level of Cliff's delta is not *Negligible*.
*   **Loss:** The result of M outperforms SimAST-GCN, if the p value less than 0.05, and the effective level of Cliff's delta is not *Negligible*.
*   **Tie:** Others.

### 4.4. Experimental Setting

In our experiments, we used the javalang tools⁴ to obtain ASTs for Java code, and we used Skip-gram algorithm implemented by gensim library [24] to train the embeddings of nodes. The embedding size was set to 300. The hidden size of Bi-GRU was 300. The number of GCN layers was 3, which is the optimal depth in pilot studies. The coefficients w<sup>o</sup> and w<sup>r</sup> were related to the dataset, and the coefficient λ of L2 regularization item was set to 10<sup>–5</sup>. Adam was utilized as the optimizer with a learning rate of 10<sup>-3</sup> to train the model, and the mini-batch was 128. We random initialized all the W and b with a uniform distribution.

All the experiments were conducted on a server with 24 cores of 3.8GHz CPU and a NVIDIA GeForce RTX 3090 GPU.

⁴ https://github.com/c2nes/javalang

---

## 5. Experimental Results

This section shows the performance of our proposed method SimAST-GCN with other baseline methods. Therefore, we put forward the following research questions:

*   **RQ1:** Does our proposed SimAST-GCN model outperform other models for automatic code review?
*   **RQ2:** How different parameter settings and module influence the performance of our method?
*   **RQ3:** Does our proposed SimAST-GCN model outperform other models in terms of time efficiency?

### 5.1. Does our proposed SimAST-GCN model outperform other models for automatic code review?

Tables 3-6 show the comparison results of four metrics on the AACR dataset. For each table, it is divided into three columns. The first column is the repository name. The second column is the corresponding metric column, which shows the metric values of our proposed SimAST-GCN method and the other three baseline methods. For each repository, the result of the best method is presented in bold. The p(δ) column shows the p values of Wilcoxon signed-rank test and Cliff's delta values between SimAST-GCN and the other three baseline methods. For the p value of Wilcoxon signed-rank test, we displayed the original value in the table if the value is not less than 0.05. Otherwise, we will display '< 0.05' in the table. For Cliff's delta value, we displayed the effective level (shown in Table 2) in the table. In order to distinguish the positive and negative Cliff's delta value, we used '+' and '-' before the effective level to represent the property. The row 'Average & Win/Tie/Loss' shows the average value of the corresponding metric and the Win/Tie/Loss indicator.

The results in all the metrics show that the proposed SimAST-GCN consistently outperforms all comparison models. This verifies the effectiveness of our proposed method at ACR.

**(Tables 3, 4, 5, 6 show detailed Accuracy, F1, AUC, and MCC scores for SimAST-GCN, DACE, TBRNN, ASTNN across 9 repositories, along with significance test results (p-values and Cliff's delta effect sizes) comparing SimAST-GCN to the baselines. SimAST-GCN generally achieves the best scores and significantly outperforms the others in most cases.)**

*(Detailed tables omitted for brevity, but they demonstrate SimAST-GCN's superiority)*

**Table 3: Accuracy** (SimAST-GCN Avg: 81.213, Win/Tie/Loss vs DACE: 9/0/0, vs TBRNN: 7/1/1, vs ASTNN: 7/0/2)
**Table 4: F1** (SimAST-GCN Avg: 0.822, Win/Tie/Loss vs DACE: 9/0/0, vs TBRNN: 8/1/0, vs ASTNN: 7/1/1)
**Table 5: AUC** (SimAST-GCN Avg: 0.764, Win/Tie/Loss vs DACE: 9/0/0, vs TBRNN: 8/1/0, vs ASTNN: 8/1/0)
**Table 6: MCC** (SimAST-GCN Avg: 0.474, Win/Tie/Loss vs DACE: 9/0/0, vs TBRNN: 9/0/0, vs ASTNN: 8/0/1)

**Figure 5:** Boxplot of four metrics of SimAST-GCN and the other three baseline methods.
*(Image omitted - Boxplots comparing Accuracy, F1, AUC, MCC for SimAST-GCN, DACE, TBRNN, ASTNN, visually confirming SimAST-GCN's higher median performance and often tighter distribution)*

Compared with the delimiter-based model (DACE), we find that SimAST-GCN achieves the best performance in all the terms of the F1, AUC, and MCC. This is because, compared to DACE, SimAST-GCN is not the delimiter-based method. We adopt an AST as the abstract code representation, which demonstrates the effectiveness of AST at code representation.

Compared with the AST-based models (TBRNN and ASTNN), SimAST-GCN also achieves the best performance according to all metrics. Although both TBRNN and ASTNN use an abstract syntax tree for source code processing, in the code review task, we find that the two methods do not perform well in comparison to SimAST-GCN. On the one hand, we simplify the AST and enhance the connection properties between nodes. On the other hand, we use a more advanced graph neural network to model the simplified AST to capture better syntactic and semantic information.

Moreover, we utilize a retrieval-based attention mechanism to capture significant sentiment features from the context representations for the source code. This mechanism dramatically improves the performance of the model, allowing the model to focus on the parts of the code that may have changed, which is widely used in natural language processing.

In summary, this is the first study to simplify the abstract syntax tree and deploy a graph structure to leverage Simplified AST for the code review task. Our experiments show the efficiency of exploiting the Simplified AST and adopting the graph neural network.

### 5.2. How different parameter settings and module influence the performance of our method?

#### 5.2.1. Parameter settings

As a key component of our model, we investigated the impact of the GCN layer number on the performance of our proposed method SimAST-GCN. We varied the number of layers from 1 to 12, and we report the results of four metrics in Figure 6. Overall, the 3-layer GCN achieves the best performance on the `accumulo` dataset. Hence, we finally set the number of GCN layers to 3 in our experiments.

Comparatively, the layers of GCN less than 3 in SimAST-GCN perform unsatisfactorily, which indicates that fewer GCN layers in SimAST-GCN are insufficient to derive the precise syntactical dependencies of the source code.

In addition, the performance of SimAST-GCN decreases as the number of GCN layers increases, and tends to decrease when the depth of the model is greater than 7. This means that simply increasing the depth of the GCN will reduce the learning ability of the model because the model parameters increase sharply.

**Figure 6:** Impact of the number of GCN layers. Four metrics based on different numbers of GCN layers are reported.
*(Image omitted - Line graphs showing Accuracy, F1, AUC, MCC vs Number of GCN Layers (1-12). Performance generally peaks around 3 layers and then degrades.)*

#### 5.2.2. Module influence

We conducted an ablation study to analyze further the impact of different components of the proposed SimAST-GCN. The results of the four metrics are shown in Table 7-10.

**(Tables 7, 8, 9, 10 show detailed Accuracy, F1, AUC, and MCC scores for SimAST-GCN and its variants (ASTGCN, SimAST, SAGCN-C) across 9 repositories, along with significance tests.)**

*(Detailed tables omitted for brevity, but they demonstrate the positive impact of both AST simplification and the GCN+Attention mechanism)*

**Table 7: Accuracy** (SimAST-GCN Avg: 81.213; ASTGCN (no simplification) Avg: 75.848; SimAST (no GCN/Attention) Avg: 79.362; SAGCN-C (concatenation instead of diff) Avg: 77.601)
**Table 8: F1** (SimAST-GCN Avg: 0.822; ASTGCN Avg: 0.792; SimAST Avg: 0.805; SAGCN-C Avg: 0.785)
**Table 9: AUC** (SimAST-GCN Avg: 0.764; ASTGCN Avg: 0.72; SimAST Avg: 0.738; SAGCN-C Avg: 0.734)
**Table 10: MCC** (SimAST-GCN Avg: 0.474; ASTGCN Avg: 0.385; SimAST Avg: 0.438; SAGCN-C Avg: 0.417)

We can observe that the model without the Simplified AST (ASTGCN) performs most unsatisfactorily on the AACR dataset. This confirms that simplifying the AST is the most significant improvement for ACR.

In addition, the removal of retrieval-based attention and GCN (SimAST) leads to a considerable performance drop. This indicates that the attention mechanism and node relations vastly improve the performance of ACR.

We further observe that the model with the connected information (SAGCN-C) declines sharply, which indicates that it is better to calculate the distance between the representations rather than connecting the representation.

### 5.3. Does our proposed SimAST-GCN model outperform other models in terms of time efficiency?

In practical applications, the training time of the model has excellent limitations on the application of the model, so we measured the training time consumption of our model SimAST-GCN and the other three baseline models. The results are shown in Figure 7.

**Figure 7:** Time consumption for SimAST-GCN and three baseline methods during training phrase.
*(Image omitted - Bar chart showing training time. SimAST-GCN is significantly faster than DACE, TBRNN, and ASTNN.)*

In Figure 7, we can observe that SimAST-GCN consumes the least amount of time than other baseline models. We believe that there are two reasons for our excellent model training efficiency. First, our model has good parallelism capability. ASTNN requires node information to propagate from leaf nodes to root nodes, and this is a sequential process. The root node cannot be calculated when the information is not propagated, which leads to a long time-consuming model. DACE and TBRNN use a large number of RNN networks in their models, so they are not very good in terms of parallelism. The SimAST-GCN model we proposed uses only a small amount of RNN network in the model, and a large number of parallel GCN networks, which greatly improves the parallelism of the network, thereby greatly reducing the time consumption of model training and improving the training efficiency of the model. Second, we preprocess the data for all models. We move the extraction of AST, the simplifying of AST, and the extraction of node relationship graphs into the preprocessing process. Thus, the execution efficiency of the model is improved.

In conclusion, our model SimAST-GCN outperforms other models in terms of time efficiency.

### 5.4. Discussion

In this section, we will discuss the effectiveness of Simplifying AST. Table 11 lists the tree size before and after simplifying the AST. We can see that the average token of the tree drops from 170 to 94. We also notice that the proportion of code tokens in all tokens has also greatly increased (from 47% to 85%), the average percentage increase is about 38 percentage points. We believe that when the AST is not simplified, the proportion of extra nodes generated is too high, which will cause the model to focus too much on the information of the extra nodes, thereby ignoring the information of the code nodes themselves. Therefore, by simplifying the AST, on the one hand, we can strengthen the contact information between nodes, and on the other hand, we can increase the proportion of code nodes, so that the two kinds of node information can be better balanced. This is why simplified AST helps to predict the code review results.

The reasons for simplifying AST are two-fold. First, after removing useless attribute nodes, the remaining attribute nodes represent the relationship between nodes, not the attributes of a specific node. For example, the “modifiers" node in Figure 3(a) means that the "static" node is a modifier node. However, the "Method Declaration" node can unify its child nodes and shorten the distance between the code nodes, thereby strengthening the connection between the nodes. Second, a smaller number of nodes can reduce the computational cost and training overhead.

**Table 11:** Statistics of the tree size for the original and simplified versions of the AST.
| Repository      | Operation   | Max token | Average token | Simplified rate | Average code token | Code token rate* | Percentage increase** |
|-----------------|-------------|-----------|---------------|-----------------|--------------------|-------------------|----------------------|
| accumulo        | Original    | 3334      | 188.52        |                 |                    | 47.33%            |                      |
|                 | Simplified  | 1949      | 105.87        | 43.84%          | 89.22              | 84.27%            | 36.95                |
| ambari          | Original    | 2407      | 217.86        |                 |                    | 47.31%            |                      |
|                 | Simplified  | 1339      | 122.36        | 43.83%          | 103.07             | 84.23%            | 36.92                |
| cloudstack      | Original    | 5036      | 217.16        |                 |                    | 47.08%            |                      |
|                 | Simplified  | 1790      | 121.73        | 43.94%          | 102.24             | 83.99%            | 36.91                |
| commons-lang    | Original    | 1718      | 112.43        |                 |                    | 47.45%            |                      |
|                 | Simplified  | 831       | 57.91         | 48.49%          | 53.35              | 92.12%            | 44.67                |
| flink           | Original    | 1928      | 145.69        |                 |                    | 47.06%            |                      |
|                 | Simplified  | 1069      | 81.38         | 44.14%          | 68.56              | 84.24%            | 37.19                |
| incubator-pinot | Original    | 3751      | 187.02        |                 |                    | 47.45%            |                      |
|                 | Simplified  | 2388      | 103.99        | 44.4%           | 88.75              | 85.34%            | 37.89                |
| kafka           | Original    | 2650      | 149.16        |                 |                    | 47.21%            |                      |
|                 | Simplified  | 1265      | 80.6          | 45.96%          | 70.42              | 87.36%            | 40.15                |
| lucene-solr     | Original    | 5467      | 242.65        |                 |                    | 46.96%            |                      |
|                 | Simplified  | 3059      | 136.02        | 43.94%          | 113.96             | 83.78%            | 36.82                |
| shardingsphere  | Original    | 434       | 73.14         |                 |                    | 47.66%            |                      |
|                 | Simplified  | 247       | 41.61         | 43.11%          | 34.86              | 83.77%            | 36.11                |
| **Average**     | **Original**|           | **170.41**    |                 |                    | **47.28%**        |                      |
|                 | **Simplified**|           | **94.61**     | **44.5%**       | **80.49**          | **85.46%**        | **38.18**            |
*Code token rate = Average code token / Average token (Original/Simplified).
**Percentage increase = Simplified code token rate - Original code token rate.

---

## 6. Related Work

### 6.1. Source Code Representation

In the field of software engineering, lots of code-related research needs to transform the code into a machine understandable form. Therefore, how to effectively represent the source code fragment is a significant challenge in the field of software engineering research.

Deep learning based methods have attracted much attention in learning representation of source code fragments. Raychev [28] uses n-gram and RNN model for the code completion task, and the main idea is to simplify the code completion problem to a natural language processing problem, that is, to predict the probability of a sentence. Allamanis [29] proposes a neural probabilistic language model for the method naming problem. They think that in similar contexts, the name tends to have similar embeddings.

However, with the deepening of the research, the researchers found that the structural information in the code is very important, so they began to study how to extract structural information in source code fragments. Mou [30] proposes a novel neural network (TBCNN), which is a tree-based model designed for programming language processing. They propose a convolution kernel used on the AST to capture the essential structural information. Lam [31] combines the project's bug-fixing history and the features built from rVSM and DNN for better accuracy in bug localization task. Huo [32] proposes a convolutional neural network NP-CNN, which is used to leverage both syntactic and semantic information. According to the bug report, NP-CNN learns unified features from the natural language and the source code fragments to predict potential buggy source code automatically. Wei [33] proposes a methods called CDLH for functional clone detection, which is an end-to-end learning framework. CDLH exploits both syntactic and semantic information to learn hash codes for fast computation between different code fragments. Zhang [15] proposes a method ASTNN. The main idea is to obtain better feature extraction ability by dividing the AST into sentence-level blocks.

Compared with these methods of serializing structural information into tokens for modeling, with the recent development of graph neural networks, many researchers have tried to directly use the original structural information for modeling instead of destroying the original structural information. Allamanis [34] represents source code fragments as graphs and uses different edge types to model semantic and syntactic relation information between different nodes. Zugner [35] combines the context and the structure information of source code and uses multiple programming languages as the dataset to improve results on every individual languages.

Unlike the previous methods, our method SimAST-GCN not only strengthens the structural information, but also uses the graph convolution network to deeply integrate the structural information and semantic information to better represent the characteristics of the source code fragments.

### 6.2. Automatic Code Review

As an crucial part of software engineering, code review plays a pivotal role in the entire software life cycle. Code review determines the review results by convening other developers to understand, analyze and discuss the code. There is no doubt that this whole process requires many human resources. Therefore, many studies are devoted to reducing the consumption of human resources in code review process. Thongtanunam [3] reveals that 4%-30% of reviews have code reviewer assignment problem. Thus, a code reviewer recommendation algorithm, File Path Similarity (FPS), was proposed to exploit the file location information to solve the problem. Zanjani [4] proposed an approach called cHRev, which is used to recommend the best suitable reviewer to participate in a given review. The method makes the recommendation based on the contributions in their prior reviews. Xia [5] proposes a recommendation algorithm which leverages the implicit relations between the reviews and the historical reviews. So, they utilize a hybrid approach, combining the latent factor models and the neighborhood methods to capture implicit relations. They are all researching how to recommend suitable reviewers to improve the efficiency of code review.

Although there are so many code reviewer recommendation related works, it can only improve the efficiency of code review, but can not effectively reduce the human effort consumption of code review [36]. Rigby [37] finds that despite differences between items, many characteristics of the review process independently converge to similar values. They believe that this represents a general principle of code review practice. Therefore, we believe that since there are general principles of code review practice, then we can use existing deep learning techniques to learn these general principles. Just like the research of deep learning technology in other aspects of software engineering. Shi [9] believes that automatic code review is a binary classification problem. Their model can learn the differences between the original file and the revised file to make the suggestion. Thus, they propose a novel model called DACE, which learns the revision features by exploiting a pairwise autoencoding and a context enrich module.

However, the understanding of automatic code review is not the only one, Tufan [38] proposes a method, learning the code changes recommended by reviewer, to implement them in the original code automatically. In other words, they are trying to make a map from the original code file to the revised code file, which is totally different from the opinion that Shi [9] hold. In this paper, our understanding of automatic code review is the same as Shi [9], so we are more focused on optimizing the representation of the code and improving the accuracy of prediction.

---

## 7. Conclusion

In this paper, we first present AACR, a challenging dataset for automatic code review. Then, we propose a Simplified AST based Graph Convolutional Network (SimAST-GCN) to extract syntactic and semantic information from source code. SimAST-GCN first extract AST from the source code and simplifying the extracted AST. Then, SimAST-GCN uses Bi-GRU to enrich the semantic information and GCN to enrich the syntactic information. Finally, SimAST-GCN composes the representations from the original code file and the revised code file to predict the results. Experimental results on the AACR dataset showed that our proposed model SimAST-GCN outperforms state-of-the-art methods, including Token-based models and GCN-based models. Our code and experimental data are publicly available at <https://github.com/SimAST-GCN/SimAST-GCN>.

---

## Acknowledgment

This work was partially supported by the National Natural Science Foundation of China (61772263, 61872177, 61972289, 61832009), the Collaborative Innovation Center of Novel Software Technology and Industrialization, and the Priority Academic Program Development of Jiangsu Higher Education Institutions.

---

## References

[1] C. Sadowski, E. Söderberg, L. Church, M. Sipko, A. Bacchelli, Modern code review: a case study at google, in: Proceedings of the 40th International Conference on Software Engineering: Software Engineering in Practice, 2018, pp. 181-190.
[2] A. Bacchelli, C. Bird, Expectations, outcomes, and challenges of modern code review, in: 2013 35th International Conference on Software Engineering (ICSE), IEEE, 2013, pp. 712-721.
[3] P. Thongtanunam, C. Tantithamthavorn, R. G. Kula, N. Yoshida, H. Iida, K.-i. Matsumoto, Who should review my code? a file location-based code-reviewer recommendation approach for modern code review, in: 2015 IEEE 22nd International Conference on Software Analysis, Evolution, and Reengineering (SANER), IEEE, 2015, pp. 141-150.
[4] M. B. Zanjani, H. Kagdi, C. Bird, Automatically recommending peer reviewers in modern code review, IEEE Transactions on Software Engineering 42 (2015) 530-543.
[5] Z. Xia, H. Sun, J. Jiang, X. Wang, X. Liu, A hybrid approach to code reviewer recommendation with collaborative filtering, in: 2017 6th International Workshop on Software Mining (SoftwareMining), IEEE, 2017, pp. 24-31.
[6] V. Balachandran, Reducing human effort and improving quality in peer code reviews using automatic static analysis and reviewer recommendation, in: 2013 35th International Conference on Software Engineering (ICSE), IEEE, 2013, pp. 931-940.
[7] G. Díaz, J. R. Bermejo, Static analysis of source code security: Assessment of tools against samate tests, Information and software technology 55 (2013) 1462-1476.
[8] G. McGraw, Automated code review tools for security, Computer 41 (2008) 108-111.
[9] S.-T. Shi, M. Li, D. Lo, F. Thung, X. Huo, Automatic code review by learning the revision of source code, in: Proceedings of the AAAI Conference on Artificial Intelligence, volume 33(01), 2019, pp. 4910-4917.
[10] J. K. Siow, C. Gao, L. Fan, S. Chen, Y. Liu, Core: Automating review recommendation for code changes, in: 2020 IEEE 27th International Conference on Software Analysis, Evolution and Reengineering (SANER), IEEE, 2020, pp. 284-295.
[11] K. Greff, R. K. Srivastava, J. Koutník, B. R. Steunebrink, J. Schmidhuber, Lstm: A search space odyssey, IEEE transactions on neural networks and learning systems 28 (2016) 2222-2232.
[12] P. Sun, R. Zhang, Y. Jiang, T. Kong, C. Xu, W. Zhan, M. Tomizuka, L. Li, Z. Yuan, C. Wang, P. Luo, Sparse r-cnn: End-to-end object detection with learnable proposals, in: Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR), 2021, pp. 14454-14463.
[13] D. Hovemeyer, W. Pugh, Finding bugs is easy, Acm sigplan notices 39 (2004) 92-106.
[14] I. D. Baxter, A. Yahin, L. Moura, M. Sant'Anna, L. Bier, Clone detection using abstract syntax trees, in: Proceedings. International Conference on Software Maintenance (Cat. No. 98CB36272), IEEE, 1998, pp. 368-377.
[15] J. Zhang, X. Wang, H. Zhang, H. Sun, K. Wang, X. Liu, A novel neural source code representation based on abstract syntax tree (2019) 783-794.
[16] L. Mou, G. Li, Z. Jin, L. Zhang, T. Wang, Tbcnn: A tree-based convolutional neural network for programming language processing, arXiv preprint arXiv:1409.5718 (2014).
[17] T. Shippey, D. Bowes, T. Hall, Automatically identifying code features for software defect prediction: Using ast n-grams, Information and Software Technology 106 (2019) 142-160.
[18] D. Tang, B. Qin, T. Liu, Document modeling with gated recurrent neural network for sentiment classification, in: Proceedings of the 2015 conference on empirical methods in natural language processing, 2015, pp. 1422-1432.
[19] A. Hindle, E. T. Barr, M. Gabel, Z. Su, P. Devanbu, On the naturalness of software, Communications of the ACM 59 (2016) 122-131.
[20] B. Ray, V. Hellendoorn, S. Godhane, Z. Tu, A. Bacchelli, P. Devanbu, On the" naturalness" of buggy code, in: 2016 IEEE/ACM 38th International Conference on Software Engineering (ICSE), IEEE, 2016, pp. 428-439.
[21] C. Fang, Z. Liu, Y. Shi, J. Huang, Q. Shi, Functional code clone detection with syntax and semantics fusion learning, in: Proceedings of the 29th ACM SIGSOFT International Symposium on Software Testing and Analysis, 2020, pp. 516-527.
[22] D. Guo, S. Ren, S. Lu, Z. Feng, D. Tang, S. Liu, L. Zhou, N. Duan, A. Svyatkovskiy, S. Fu, et al., Graphcodebert: Pre-training code representations with data flow, arXiv preprint arXiv:2009.08366 (2020).
[23] C. Zhang, Q. Li, D. Song, Aspect-based sentiment classification with aspect-specific graph convolutional networks, arXiv preprint arXiv:1909.03477 (2019).
[24] R. Řehůřek, P. Sojka, Software Framework for Topic Modelling with Large Corpora, in: Proceedings of the LREC 2010 Workshop on New Challenges for NLP Frameworks, ELRA, Valletta, Malta, 2010, pp. 45-50. http://is.muni.cz/publication/884893/en.
[25] G. Fan, X. Diao, H. Yu, K. Yang, L. Chen, Deep semantic feature learning with embedded static metrics for software defect prediction, in: 2019 26th Asia-Pacific Software Engineering Conference (APSEC), 2019, pp. 244-251. doi:10.1109/APSEC48747.2019.00041.
[26] Y. Liu, Y. Li, J. Guo, Y. Zhou, B. Xu, Connecting software metrics across versions to predict defects, in: 2018 IEEE 25th International Conference on Software Analysis, Evolution and Reengineering (SANER), 2018, pp. 232-243. doi:10.1109/SANER.2018.8330212.
[27] G. Macbeth, E. Razumiejczyk, R. D. Ledesma, Cliff's delta calculator: A non-parametric effect size program for two groups of observations, Universitas Psychologica 10 (2011) 545-555.
[28] V. Raychev, M. Vechev, E. Yahav, Code completion with statistical language models, in: Proceedings of the 35th ACM SIGPLAN Conference on Programming Language Design and Implementation, 2014, pp. 419-428.
[29] M. Allamanis, E. T. Barr, C. Bird, C. Sutton, Suggesting accurate method and class names, in: Proceedings of the 2015 10th Joint Meeting on Foundations of Software Engineering, 2015, pp. 38-49.
[30] L. Mou, G. Li, L. Zhang, T. Wang, Z. Jin, Convolutional neural networks over tree structures for programming language processing, in: Thirtieth AAAI Conference on Artificial Intelligence, 2016.
[31] A. N. Lam, A. T. Nguyen, H. A. Nguyen, T. N. Nguyen, Combining deep learning with information retrieval to localize buggy files for bug reports (n), in: 2015 30th IEEE/ACM International Conference on Automated Software Engineering (ASE), IEEE, 2015, pp. 476-481.
[32] X. Huo, M. Li, Z.-H. Zhou, et al., Learning unified features from natural and programming languages for locating buggy source code., in: IJCAI, volume 16, 2016, pp. 1606-1612.
[33] H. Wei, M. Li, Supervised deep features for software functional clone detection by exploiting lexical and syntactical information in source code., in: IJCAI, 2017, pp. 3034-3040.
[34] M. Allamanis, M. Brockschmidt, M. Khademi, Learning to represent programs with graphs, arXiv preprint arXiv:1711.00740 (2017).
[35] D. Zügner, T. Kirschstein, M. Catasta, J. Leskovec, S. Günnemann, Language-agnostic representation learning of source code from structure and context, arXiv preprint arXiv:2103.11318 (2021).
[36] D. Singh, V. R. Sekar, K. T. Stolee, B. Johnson, Evaluating how static analysis tools can reduce code review effort, in: 2017 IEEE Symposium on Visual Languages and Human-Centric Computing (VL/HCC), IEEE, 2017, pp. 101-105.
[37] P. C. Rigby, C. Bird, Convergent contemporary software peer review practices, in: Proceedings of the 2013 9th Joint Meeting on Foundations of Software Engineering, 2013, pp. 202-212.
[38] R. Tufan, L. Pascarella, M. Tufanoy, D. Poshyvanykz, G. Bavota, Towards automating code review activities, in: 2021 IEEE/ACM 43rd International Conference on Software Engineering (ICSE), IEEE, 2021, pp. 163-174.