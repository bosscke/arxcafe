// seed-ml-questions.js
// Run with: node seed-ml-questions.js

const { MongoClient } = require('mongodb');

const questions = [
  {
    question_text: "What is Machine Learning and why does it exist?",
    options: ["A. A method for writing rules manually to automate decisions", "B. A system that memorizes historical data", "C. A technique that enables systems to learn patterns from data without explicit programming", "D. A statistical method used only for academic research"],
    correct_answer: "C",
    phase: 1,
    domain: "Core ML Foundations",
    explanation: "Machine Learning enables systems to learn patterns from data without explicit programming, solving the problem of scalable automation."
  },
  {
    question_text: "What problem does supervised learning solve?",
    options: ["A. Discovering hidden structures in unlabeled data", "B. Learning optimal actions through trial and error", "C. Mapping inputs to known outputs using labeled data", "D. Reducing the dimensionality of datasets"],
    correct_answer: "C",
    phase: 1,
    domain: "Core ML Foundations",
    explanation: "Supervised learning maps inputs to known outputs using labeled data, enabling prediction and classification tasks."
  },
  {
    question_text: "What is supervised learning NOT?",
    options: ["A. A method requiring labeled examples", "B. A technique used for regression and classification", "C. A form of reinforcement learning", "D. A way to learn input–output mappings"],
    correct_answer: "C",
    phase: 1,
    domain: "Core ML Foundations",
    explanation: "Supervised learning is distinct from reinforcement learning, which learns from rewards/penalties, not labeled examples."
  },
  {
    question_text: "What is unsupervised learning and why does it exist?",
    options: ["A. To predict known labels with high accuracy", "B. To discover patterns or structure in unlabeled data", "C. To optimize rewards through interaction", "D. To reduce training costs of supervised models"],
    correct_answer: "B",
    phase: 1,
    domain: "Core ML Foundations",
    explanation: "Unsupervised learning discovers patterns and structure in unlabeled data, solving exploratory and clustering problems."
  },
  {
    question_text: "What problem does clustering primarily solve?",
    options: ["A. Predicting continuous values", "B. Assigning predefined labels to data", "C. Grouping similar data points without labels", "D. Reducing overfitting in neural networks"],
    correct_answer: "C",
    phase: 1,
    domain: "Core ML Foundations",
    explanation: "Clustering groups similar data points without predefined labels, enabling customer segmentation and anomaly detection."
  },
  {
    question_text: "What is clustering NOT typically used for?",
    options: ["A. Customer segmentation", "B. Anomaly detection", "C. Direct prediction of labeled outcomes", "D. Exploratory data analysis"],
    correct_answer: "C",
    phase: 1,
    domain: "Core ML Foundations",
    explanation: "Clustering is unsupervised and does not directly predict labeled outcomes; that requires supervised learning."
  },
  {
    question_text: "What is reinforcement learning and why does it exist?",
    options: ["A. To learn from static labeled datasets", "B. To discover correlations in large datasets", "C. To learn optimal actions via rewards and penalties", "D. To compress data efficiently"],
    correct_answer: "C",
    phase: 1,
    domain: "Core ML Foundations",
    explanation: "Reinforcement learning learns optimal actions through rewards and penalties, solving sequential decision-making problems."
  },
  {
    question_text: "What problem does reinforcement learning solve best?",
    options: ["A. Static classification problems", "B. Sequential decision-making under uncertainty", "C. Feature scaling", "D. Data labeling automation"],
    correct_answer: "B",
    phase: 1,
    domain: "Core ML Foundations",
    explanation: "RL excels at sequential decision-making where an agent learns actions that maximize cumulative rewards over time."
  },
  {
    question_text: "What is reinforcement learning NOT dependent on?",
    options: ["A. An environment", "B. A reward signal", "C. Explicit labeled input-output pairs", "D. An agent taking actions"],
    correct_answer: "C",
    phase: 1,
    domain: "Core ML Foundations",
    explanation: "RL uses rewards, not labeled pairs; it learns from interaction with an environment."
  },
  {
    question_text: "What is a feature in machine learning?",
    options: ["A. The output of a model", "B. A measurable property used as input to a model", "C. A training algorithm", "D. A deployment artifact"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Foundations",
    explanation: "A feature is a measurable input property that represents raw data in a form the model can use."
  },
  {
    question_text: "Why do features exist in ML systems?",
    options: ["A. To increase model complexity", "B. To represent raw data in a model-consumable form", "C. To replace labels", "D. To reduce storage costs"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Features bridge raw data and models, transforming observations into signals the model can learn from."
  },
  {
    question_text: "What is a feature NOT?",
    options: ["A. An input variable", "B. A transformed representation of data", "C. A target value", "D. A signal used by the model"],
    correct_answer: "C",
    phase: 1,
    domain: "Data Foundations",
    explanation: "A feature is an input; a target/label is the output. They are distinct concepts."
  },
  {
    question_text: "What is a label in supervised learning?",
    options: ["A. A transformed input feature", "B. The correct output associated with an input", "C. A hyperparameter", "D. A prediction generated by the model"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Foundations",
    explanation: "A label is ground truth—the correct output for a given input during training."
  },
  {
    question_text: "Why do labels exist?",
    options: ["A. To evaluate unsupervised algorithms", "B. To guide the learning process by providing ground truth", "C. To reduce dimensionality", "D. To deploy models to production"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Labels guide supervised learning by providing ground truth for the model to learn against."
  },
  {
    question_text: "What is a label NOT?",
    options: ["A. Ground truth", "B. Model output during inference", "C. Training target", "D. Supervised learning requirement"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Foundations",
    explanation: "A label is ground truth (training data); model output during inference is a prediction."
  },
  {
    question_text: "What is a training dataset?",
    options: ["A. Data used only for final evaluation", "B. Data used to tune hyperparameters", "C. Data used to fit model parameters", "D. Data collected after deployment"],
    correct_answer: "C",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Training data is used to optimize model parameters through the learning algorithm."
  },
  {
    question_text: "Why does a training dataset exist?",
    options: ["A. To test model generalization", "B. To estimate real-world performance", "C. To allow the model to learn patterns", "D. To monitor model drift"],
    correct_answer: "C",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Training data enables the model to learn patterns and fit parameters."
  },
  {
    question_text: "What is a training dataset NOT intended for?",
    options: ["A. Learning model parameters", "B. Measuring unbiased performance", "C. Feeding into training pipelines", "D. Feature extraction"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Training performance is biased; unbiased performance is measured on separate test data."
  },
  {
    question_text: "What is a validation dataset?",
    options: ["A. Data used to deploy the model", "B. Data used to tune model choices", "C. Data used only after deployment", "D. Data used to generate labels"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Validation data tunes hyperparameters and model choices without biasing the final test evaluation."
  },
  {
    question_text: "Why does a validation dataset exist?",
    options: ["A. To maximize training accuracy", "B. To tune hyperparameters without biasing test results", "C. To replace the test set", "D. To retrain models continuously"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Validation prevents hyperparameter tuning from overfitting to test data."
  },
  {
    question_text: "What is a validation dataset NOT used for?",
    options: ["A. Model selection", "B. Hyperparameter tuning", "C. Final performance reporting", "D. Early stopping"],
    correct_answer: "C",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Final performance is reported using test data, not validation data."
  },
  {
    question_text: "What is a test dataset?",
    options: ["A. Data used to train the model", "B. Data used during hyperparameter tuning", "C. Data used to estimate final model performance", "D. Data used for feature engineering"],
    correct_answer: "C",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Test data estimates final performance on unseen data."
  },
  {
    question_text: "Why does a test dataset exist?",
    options: ["A. To improve training speed", "B. To simulate real-world unseen data", "C. To debug data pipelines", "D. To reduce variance"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Test data simulates real-world unseen data to estimate true generalization."
  },
  {
    question_text: "What is a test dataset NOT used for?",
    options: ["A. Model evaluation", "B. Performance reporting", "C. Hyperparameter tuning", "D. Generalization estimation"],
    correct_answer: "C",
    phase: 1,
    domain: "Data Foundations",
    explanation: "Hyperparameter tuning uses validation, not test data, to avoid biasing final results."
  },
  {
    question_text: "What is overfitting?",
    options: ["A. A model failing to learn from data", "B. A model learning noise instead of general patterns", "C. A model with too few parameters", "D. A model trained on insufficient data"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Behavior",
    explanation: "Overfitting is when a model learns training noise, causing poor generalization to unseen data."
  },
  {
    question_text: "Why does overfitting occur?",
    options: ["A. Too much regularization", "B. Excessive model complexity relative to data", "C. Poor evaluation metrics", "D. Insufficient compute resources"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Behavior",
    explanation: "Overfitting occurs when model capacity exceeds the signal in training data."
  },
  {
    question_text: "What is overfitting NOT?",
    options: ["A. High training accuracy with low test accuracy", "B. Memorization of noise", "C. Poor generalization", "D. Underfitting"],
    correct_answer: "D",
    phase: 1,
    domain: "Model Behavior",
    explanation: "Underfitting is the opposite of overfitting—too simple a model."
  },
  {
    question_text: "What is underfitting?",
    options: ["A. A model that memorizes training data", "B. A model too simple to capture underlying patterns", "C. A model with high variance", "D. A model that generalizes too well"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Behavior",
    explanation: "Underfitting is when a model is too simple to learn patterns, resulting in poor training performance."
  },
  {
    question_text: "Why does underfitting occur?",
    options: ["A. Excessive model complexity", "B. Too much training data", "C. Insufficient model capacity", "D. Data leakage"],
    correct_answer: "C",
    phase: 1,
    domain: "Model Behavior",
    explanation: "Underfitting occurs when model capacity is insufficient for the problem complexity."
  },
  {
    question_text: "What is underfitting NOT characterized by?",
    options: ["A. High bias", "B. Poor training performance", "C. Poor test performance", "D. Extremely high variance"],
    correct_answer: "D",
    phase: 1,
    domain: "Model Behavior",
    explanation: "Underfitting has high bias and low variance, not high variance."
  },
  {
    question_text: "What is bias in the bias–variance tradeoff?",
    options: ["A. Random error from noise", "B. Error from overly complex models", "C. Error from overly simplistic assumptions", "D. Ethical unfairness in datasets"],
    correct_answer: "C",
    phase: 1,
    domain: "Model Behavior",
    explanation: "Bias is systematic error from oversimplified assumptions (underfitting)."
  },
  {
    question_text: "What is variance in the bias–variance tradeoff?",
    options: ["A. Error from oversimplification", "B. Error from sensitivity to training data", "C. Error caused by poor labels", "D. Error caused by evaluation metrics"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Behavior",
    explanation: "Variance is error from sensitivity to training data (overfitting)."
  },
  {
    question_text: "What is the bias–variance tradeoff?",
    options: ["A. A tradeoff between data size and compute", "B. A balance between underfitting and overfitting", "C. A choice between supervised and unsupervised learning", "D. A deployment strategy"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Behavior",
    explanation: "The bias-variance tradeoff balances underfitting (high bias) vs overfitting (high variance)."
  },
  {
    question_text: "What is data leakage?",
    options: ["A. Loss of data during pipeline execution", "B. Use of future or forbidden information during training", "C. Incomplete data ingestion", "D. Missing labels"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Quality",
    explanation: "Data leakage is using future or forbidden information during training, inflating performance."
  },
  {
    question_text: "Why is data leakage dangerous?",
    options: ["A. It increases training time", "B. It inflates performance estimates unrealistically", "C. It reduces model complexity", "D. It causes underfitting"],
    correct_answer: "B",
    phase: 1,
    domain: "Data Quality",
    explanation: "Data leakage makes models appear better in testing than they'll be in production."
  },
  {
    question_text: "What is data leakage NOT?",
    options: ["A. Feature contamination", "B. Label leakage", "C. Training on test data", "D. Model drift"],
    correct_answer: "D",
    phase: 1,
    domain: "Data Quality",
    explanation: "Model drift is performance degradation over time; leakage is training contamination."
  },
  {
    question_text: "What is generalization in ML?",
    options: ["A. Memorizing training data", "B. Performing well on unseen data", "C. Reducing model size", "D. Increasing training accuracy"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Evaluation",
    explanation: "Generalization is performance on unseen data—the ultimate goal of ML."
  },
  {
    question_text: "Why does generalization matter?",
    options: ["A. To maximize training loss", "B. To ensure real-world usefulness", "C. To reduce feature count", "D. To speed up inference"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Evaluation",
    explanation: "Generalization ensures models work in production on data they haven't seen."
  },
  {
    question_text: "What is generalization NOT guaranteed by?",
    options: ["A. High training accuracy", "B. Proper evaluation", "C. Representative datasets", "D. Controlled validation"],
    correct_answer: "A",
    phase: 1,
    domain: "Model Evaluation",
    explanation: "High training accuracy alone doesn't guarantee generalization; a model can overfit."
  },
  {
    question_text: "What is a baseline model?",
    options: ["A. The final production model", "B. A simple reference model for comparison", "C. A highly optimized deep learning model", "D. A pretrained model"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Evaluation",
    explanation: "A baseline is a simple reference model to benchmark more complex models against."
  },
  {
    question_text: "Why do baseline models exist?",
    options: ["A. To reduce infrastructure cost", "B. To provide a minimum performance benchmark", "C. To replace evaluation metrics", "D. To deploy quickly"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Evaluation",
    explanation: "Baselines establish a minimum performance standard for comparison."
  },
  {
    question_text: "What is a baseline model NOT intended to be?",
    options: ["A. Simple", "B. Interpretable", "C. A performance benchmark", "D. Highly complex"],
    correct_answer: "D",
    phase: 1,
    domain: "Model Evaluation",
    explanation: "Baselines are intentionally simple for easy interpretation and comparison."
  },
  {
    question_text: "What is a metric in machine learning?",
    options: ["A. A loss function", "B. A numerical measure of model performance", "C. A feature", "D. A label"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Evaluation",
    explanation: "A metric is a numerical measure of model performance (e.g., accuracy, precision, AUC)."
  },
  {
    question_text: "Why do metrics exist?",
    options: ["A. To tune features", "B. To objectively evaluate model performance", "C. To replace loss functions", "D. To train models faster"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Evaluation",
    explanation: "Metrics provide objective measures for evaluating and comparing models."
  },
  {
    question_text: "What is a metric NOT?",
    options: ["A. Evaluation criterion", "B. Optimization objective (always)", "C. Performance measure", "D. Decision aid"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Evaluation",
    explanation: "Metrics may not always be the optimization objective (e.g., optimize loss, evaluate accuracy)."
  },
  {
    question_text: "What is a loss function?",
    options: ["A. A business KPI", "B. A measure optimized during training", "C. A deployment strategy", "D. A data validation rule"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Optimization",
    explanation: "A loss function is optimized during training to guide parameter updates."
  },
  {
    question_text: "Why does a loss function exist?",
    options: ["A. To evaluate final model performance", "B. To guide parameter optimization during training", "C. To select features", "D. To monitor drift"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Optimization",
    explanation: "Loss functions drive training by quantifying prediction error."
  },
  {
    question_text: "What is a loss function NOT designed for?",
    options: ["A. Training optimization", "B. Gradient computation", "C. Direct business reporting", "D. Model improvement"],
    correct_answer: "C",
    phase: 1,
    domain: "Model Optimization",
    explanation: "Loss functions are technical; business reporting requires interpretable metrics."
  },
  {
    question_text: "What is inference in machine learning?",
    options: ["A. Training a model", "B. Evaluating a validation set", "C. Using a trained model to make predictions", "D. Feature engineering"],
    correct_answer: "C",
    phase: 1,
    domain: "Model Deployment",
    explanation: "Inference is applying a trained model to new data to generate predictions."
  },
  {
    question_text: "Why does inference matter?",
    options: ["A. It determines training speed", "B. It impacts real-world latency and cost", "C. It replaces evaluation", "D. It reduces overfitting"],
    correct_answer: "B",
    phase: 1,
    domain: "Model Deployment",
    explanation: "Inference latency and cost directly affect production system performance and economics."
  }
];

async function seedQuestions() {
  const client = new MongoClient('mongodb://127.0.0.1:27017');
  
  try {
    await client.connect();
    const db = client.db('arxcafe');
    const collection = db.collection('ml_engineer_questions');

    // Clear existing questions
    await collection.deleteMany({});
    
    // Insert new questions
    const result = await collection.insertMany(questions);
    console.log(`✓ Inserted ${result.insertedCount} questions`);
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await client.close();
  }
}

seedQuestions();
