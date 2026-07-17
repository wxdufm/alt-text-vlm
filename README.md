
## Results
We did a total of 7 trials to fine-tune a working model. After each trial, we analyzed the model output to try to understand why it wasn’t performing as expected, and then changed parameters or improved data quality as needed to make the next trial better. Each trial’s adapters with the lowest val loss were tested on a validation dataset of 80.

Here are the results

| Trial | Base precision | LoRA Rank / α | Output format                            | Best checkpoint   | Val loss (min)       | Well-formed       | Within 130 char | Avg. similarity |
| ----- | -------------- | ------------- | ---------------------------------------- | ----------------- | -------------------- | ----------------- | --------------- | --------------- |
| 1st   | 4-bit          | 8 / 16        | long in-context style guide (broken)     | final (only save) | not tracked          | **0/80 (0%)**     | 0/80 (0%)       | 0.000           |
| 2nd   | **8-bit**      | 32 / 16       | 4-tag                                    | checkpoint 700    | 0.779 @700           | **78/80 (97.5%)** | 69/80 (86.3%)   | 0.496           |
| 3rd   | 4-bit          | 32 / 16       | 4-tag                                    | checkpoint 700    | 0.789 @700–800       | **79/80 (98.8%)** | 73/80 (91.3%)   | 0.488           |
| 4th   | 4-bit          | 16 / 8        | 4-tag (standardized reasoning, 133 rows) | final (iter 3552) | 0.856 @900           | 31/80 (38.8%)     | 31/80 (38.8%)   | 0.477           |
| 5th   | 4-bit          | 16 / 8        | 3-tag                                    | checkpoint 900    | 0.848–0.856 @800–900 | 74/80 (92.5%)     | 72/80 (90.0%)   | 0.504           |
| 6th   | 4-bit          | 32 / 16       | 3-tag                                    | checkpoint 700    | 0.850 @500           | 47/80 (58.8%)     | 45/80 (56.3%)   | 0.517           |
| 7th   | 4-bit          | 32 / 16       | 4-tag (standardized reasoning, all rows) | checkpoint 800    | 0.852 @800           | **76/80 (95.0%)** | 74/80 (92.5%)   | 0.488           |

- **Well formed**: This scores whether the model output is in the required format. Depending on the trial, either of these two out format were required:
    - 4-tag (1st*, 2nd, 3rd, 4th, 7th): `<description>`, `<confidence-score>`, `<confidence-reasoning>`, `<review-triggers>`
    - 3-tag (5th, 6th): `<description>`, `<confidence-score>`, `<review-triggers>` — confidence-reasoning dropped for these two trials only, then reinstated for 7th.
- **Within 130 char**: This scores whether the model's alt text or description is at most 130 characters long. This number was decided from the recommendation of maximum alt text length that is usually around 125 characters.
- **Avg. similarity**:  This scores how the model's alt text or description is similar to the human reviewed and approved one in the validation dataset. This score is computer using "SequenceMatcher" from the python library "difflib". The same applies to 2nd trial.


Overall, the best adapter is 3rd-trial checkpoint 700. However, from this trial, the confidence-reasoning field was not standardized since it was written by humans with no clear guidelines, which make this field not reliable. The same applies to 2nd-trial checkpoint 700.
Thus, the next best adapter is 7th-trial checkpoint 800 which has the 4 tag output structure. Then there is 5th-trial checkpoint 900 which has the 3 tag output structure.



## Next Steps
Despite trying our best, we were limited by the amount of data and computing power we had. This project represents a great start into building an album cover alt text AI generator but as of now isn't ready for mass generation as its quality is not guaranteed.

The next steps will build on from our work and lessons learnt (see `final_fine_tuning_report.md` to learn about the entire process in details) and make a high quality consistent model. Next steps include:
- **Have a large training and validation dataset**: Our dataset was limited with a total of 524, 444 for training and 80 for validation. Thus, the different rial models reached their lowest valid loss around iterations 700 to 900, and from there they were basically memorizing the training data instead of learning from it. A larger dataset would mean more things that the model can learn from and become better in different types of covers. It is recommended to have at least 1,000 data in total with 80% training and 20% validation.
- **Tweak the different training parameters**: The main training parameters we changed past 1st-trial was lora-rank switching between 16 and 32 while keeping the **rank/α** ratio at the same to 0.5. With a larger dataset, playing with the different parameters, and just doing trial and errors, a great model can be made.
- **Have larger computing power**: Training a VLM takes a lot of computing power. We were using a macmini with only 24gb of ram and so were limited in what we could do. Namely, using an 8bit model crashed in 2nd-trial, and batch-size higher than 1 crashed constantly. Thus, having larger computing power could open more possibilities.