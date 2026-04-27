/**
 * Terms-of-Service and Privacy Policy content rendered in the acceptance gate.
 *
 * Both TOS_TEXT and PRIVACY_TEXT are mirrors of the canonical lawyer-
 * approved sources under infra/legal/TOS-v<version>.md and
 * infra/legal/PRIVACY-v<version>.md. The strings + CURRENT_TOS_VERSION
 * constant are the contract with tos-section.tsx (renderer) and the
 * LiteLLM server-side acceptance endpoint (which records the version
 * plus the SHA256 of the text presented).
 *
 * When legal delivers revised text:
 *   1. Update infra/legal/TOS-v<new>.md or PRIVACY-v<new>.md.
 *   2. Run scripts/inject-tos-text.py <new> to re-sync TOS_TEXT + SHA,
 *      or hand-edit PRIVACY_TEXT and re-run the SHA helper in the
 *      TOS_TEXT_SHA256 docstring below.
 *   3. Bump CURRENT_TOS_VERSION to a user-facing version string.
 *   4. Every user on the previous version will be re-prompted at next launch.
 */

/** Increment this on any MATERIAL TOS change (data-use, liability, new fees).
 *  Non-material edits (typo fix, rewording) should NOT bump — re-prompting
 *  users for trivial changes trains them to click-through.
 *
 *  The string is stored verbatim in the server-side acceptance row, so it
 *  is the legal anchor for "which TOS did this user agree to". */
export const CURRENT_TOS_VERSION = "1.0"

/** SHA-256 hex of `TOS_TEXT` below, computed at commit time.
 *
 *  Every acceptance POST includes this so server-side rows tie back to the
 *  exact text the user saw, even if the source file is later edited or the
 *  git history is rewritten. Build-time guard in `.github/workflows/gpd-release.yml`
 *  (`tos-guard` job) re-hashes TOS_TEXT and fails the release if the constant
 *  is stale.
 *
 *  Regenerate locally after editing TOS_TEXT:
 *    python3 -c "import re,hashlib,pathlib; s=pathlib.Path('packages/app/src/components/tos-content.tsx').read_text(); \
 *      print(hashlib.sha256(re.search(r'export const TOS_TEXT = \`([^\`]+)\`', s).group(1).encode()).hexdigest())" */
export const TOS_TEXT_SHA256 =
  "e397850684111cb64bb96069c9e7ab5ad94fd1ff88a2b3239b508f203c85119c"

/** SHA-256 hex of `PRIVACY_TEXT` — same update/verify discipline as above. */
export const PRIVACY_TEXT_SHA256 =
  "aa46d3f294929e83254060c3c30dfcdafe67c0d21dafb6b5f5725bbd54b7f955"

/** localStorage key under which the last-accepted TOS version is cached.
 *  SetupGate compares this against CURRENT_TOS_VERSION on every launch to
 *  decide whether to re-prompt. Wiping this key (via dev tools) simulates
 *  a fresh install without touching the LiteLLM auth state. */
export const TOS_ACCEPTED_VERSION_STORAGE_KEY = "gpd.tos.acceptedVersion"

// NOTE: the previous `KEY_CACHE_STORAGE_KEY = "gpd.apiKey"` constant has
// been REMOVED. We no longer cache the raw LiteLLM virtual key in WebKit/
// WebView2 localStorage because:
//
//   * WebView's localStorage sandboxing differs across macOS / Windows /
//     Linux (leveldb ACLs on Windows + NFS home-dirs are the problem
//     cases); we couldn't uniformly verify the "same trust envelope as
//     auth.json" claim.
//   * An XSS escape in the webview would exfil the key; auth.json is
//     protected by 0600 FS permissions regardless.
//
// The TOS version-bump gate now asks Tauri (`platform.readGpdKey()`) to
// re-read auth.json at acceptance time. Key stays in exactly one place.

/** Human-readable Terms-of-Service text. Rendered as pre-wrap; line-breaks shown.
 *
 *  Contract of use. Legal terms governing the relationship between the
 *  researcher and PSI. Scope, warranty disclaimers, liability, institutional
 *  authorization. Privacy practices live in `PRIVACY_TEXT` below (split per
 *  GDPR Art. 7(2) granular-consent requirement). */
export const TOS_TEXT = `PSI
Get Physics Done (GPD)
Software End User License Agreement

This End User License Agreement (this "Agreement") is a binding agreement between Physical Superintelligence PBC ("Licensor") and you or the corporation, governmental organization, or other legal entity for which you are entering into this Agreement ("Licensee").

LICENSOR PROVIDES THE SOFTWARE SOLELY ON THE TERMS AND CONDITIONS SET FORTH IN THIS AGREEMENT AND ON THE CONDITION THAT LICENSEE ACCEPTS AND COMPLIES WITH THEM. BY CLICKING A BUTTON OR CHECKING A BOX MARKED "I AGREE" (OR SOMETHING SIMILAR), OR SUCH OTHER MEANS PROVIDED FOR ACCEPTANCE, YOU (A) ACCEPT THIS AGREEMENT AND AGREE THAT LICENSEE IS LEGALLY BOUND BY ITS TERMS; AND (B) REPRESENT AND WARRANT THAT: (I) YOU ARE OF LEGAL AGE TO ENTER INTO A BINDING AGREEMENT; AND (II) IF LICENSEE IS A CORPORATION, GOVERNMENTAL ORGANIZATION, OR OTHER LEGAL ENTITY, YOU HAVE THE RIGHT, POWER, AND AUTHORITY TO ENTER INTO THIS AGREEMENT ON BEHALF OF LICENSEE AND BIND LICENSEE TO ITS TERMS.

NOTWITHSTANDING ANYTHING TO THE CONTRARY IN THIS AGREEMENT OR YOUR OR LICENSEE'S ACCEPTANCE OF THE TERMS AND CONDITIONS OF THIS AGREEMENT, NO LICENSE IS GRANTED (WHETHER EXPRESSLY, BY IMPLICATION, OR OTHERWISE) UNDER THIS AGREEMENT, AND THIS AGREEMENT EXPRESSLY EXCLUDES ANY RIGHT, CONCERNING ANY SOFTWARE THAT LICENSEE DID NOT ACQUIRE LAWFULLY OR THAT IS NOT A LEGITIMATE, AUTHORIZED COPY OF LICENSOR'S SOFTWARE.

PLEASE READ THE TERMS OF THIS AGREEMENT CAREFULLY TO ENSURE THAT YOU UNDERSTAND EACH PROVISION. THIS AGREEMENT CONTAINS A MANDATORY INDIVIDUAL ARBITRATION PROVISION IN SECTION 15(b) (THE "ARBITRATION AGREEMENT") AND A CLASS ACTION/JURY TRIAL WAIVER PROVISION IN SECTION 15(c) (THE "CLASS ACTION/JURY TRIAL WAIVER") THAT REQUIRE, UNLESS YOU OPT OUT PURSUANT TO THE INSTRUCTIONS IN THE ARBITRATION AGREEMENT, THE EXCLUSIVE USE OF FINAL AND BINDING ARBITRATION ON AN INDIVIDUAL BASIS TO RESOLVE DISPUTES BETWEEN YOU AND US, INCLUDING ANY CLAIMS THAT AROSE OR WERE ASSERTED BEFORE YOU AGREED TO THIS AGREEMENT. TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAWS AND REGULATIONS, YOU EXPRESSLY WAIVE YOUR RIGHT TO SEEK RELIEF IN A COURT OF LAW AND TO HAVE A JURY TRIAL ON YOUR CLAIMS, AS WELL AS YOUR RIGHT TO PARTICIPATE AS A PLAINTIFF OR CLASS MEMBER IN ANY CLASS, COLLECTIVE, PRIVATE ATTORNEY GENERAL, OR REPRESENTATIVE ACTION OR PROCEEDING.

IF LICENSEE DOES NOT AGREE TO THE TERMS OF THIS AGREEMENT, LICENSOR WILL NOT AND DOES NOT LICENSE THE SOFTWARE TO LICENSEE AND YOU MUST NOT DOWNLOAD OR INSTALL THE SOFTWARE OR DOCUMENTATION.

1. Definitions. For purposes of this Agreement, the following terms have the following meanings:

"Account Credentials" means the usernames, passwords, multi-factor authentication tokens, API keys, session tokens, and other security credentials used to authenticate to and access the Software.

"AI Input" means information, data, materials, text, prompts, images, works, code, or other content that is input, entered, posted, uploaded, submitted, transferred, or otherwise transmitted by or on behalf of Licensee or any other Authorized User through the Software.

"AI Output" means information, data, materials, text, images, code, works, or other content generated by or otherwise output from the Software in response to AI Input.

"AI Technology" means any and all machine learning, deep learning, and other artificial intelligence technologies, including statistical learning algorithms, models (including large language models), neural networks, and other artificial intelligence tools or methodologies, all software implementations of any of the foregoing, and related hardware or equipment capable of generating various types of content (including text, images, video, audio, or computer code) based on user-supplied prompts.

"Authorized Users" means solely those individuals authorized to use the Software pursuant to the license granted under this Agreement.

"Documentation" means Licensor's user manuals, handbooks, and installation guides relating to the Software provided by Licensor to Licensee either electronically or in hard copy form.

"Intellectual Property Rights" means any and all registered and unregistered rights granted, applied for, or otherwise now or hereafter in existence under or related to any patent, copyright, trademark, trade secret, database protection, or other intellectual property rights laws, and all similar or equivalent rights or forms of protection, in any part of the world.

"Licensee Data" means AI Input and AI Output.

"Licensor IP" means the Software, the Documentation, and all intellectual property provided to Licensee or any other Authorized User in connection with the foregoing. Licensor IP includes all modifications, enhancements, refinements, adaptations, customizations, improvements, and derivative works of the Software and Documentation.

"Person" means an individual, corporation, partnership, joint venture, limited liability company, governmental authority, unincorporated organization, trust, association, or other entity.

"Software" means Licensor's Get Physics Done software application made available by Licensor in object code format under this Agreement, including any Updates provided to Licensee pursuant to this Agreement.

"Third Party" means any Person other than Licensee or Licensor.

"Training Data" means any and all information, data, materials, text, prompts, images, code, and other content that is used by or on behalf of Licensor to train, validate, test, retrain, or improve any AI Technology incorporated into or used with, in connection with, or in support of, the Software or Documentation. Training Data does not include Licensee Data.

"Updates" means any updates, bug fixes, patches, or other error corrections to the Software that Licensor generally makes available free of charge to all licensees of the Software.

2. License Grant and Scope. Subject to and conditioned upon Licensee's compliance with all terms and conditions set forth in this Agreement, Licensor hereby grants Licensee a non-exclusive, non-sublicensable, non-transferable, license, during the Term and solely by and through its Authorized Users, to: (a) install, use and run the Software as properly installed in accordance with this Agreement and the Documentation, solely as set forth in the Documentation and solely for Licensee's internal purposes; and (b) use the Documentation, solely in support of its licensed use of the Software in accordance herewith. Licensee must maintain the security of all of its Account Credentials. Licensee are responsible for all activities that occur with respect to the Software via Licensee's Account Credentials.

3. Third-Party Materials. The Software includes software, content, data, or other materials, including related documentation, that are owned by Persons other than Licensor and that are provided to Licensee on licensee terms that are in addition to and/or different from those contained in this Agreement ("Third-Party Licenses"). A list of all materials included in the Software and provided under Third-Party Licenses can be found at https://github.com/psi-oss/gpd-app/blob/gpd/THIRD_PARTY_NOTICES.md. Licensee is bound by and shall comply with all Third-Party Licenses. Any breach by Licensee or any of its Authorized Users of any Third-Party License is also a breach of this Agreement.

4. Use Restrictions. Licensee shall not, and shall require its Authorized Users not to, directly or indirectly:

(a) use (including making any copies of) the Software or Documentation beyond the scope of the license granted under Section 2;

(b) provide any other Person, including any subcontractor, independent contractor, affiliate, or service provider of Licensee, with access to or use of the Software or Documentation;

(c) modify, translate, adapt, or otherwise create derivative works or improvements, whether or not patentable, of the Software or Documentation or any part thereof;

(d) combine the Software or any part thereof with, or incorporate the Software or any part thereof in, any other programs;

(e) reverse engineer, disassemble, decompile, decode, or duplicate the Software, reproduce Training Data, engage in model extraction, or otherwise attempt to derive or gain access to any source code, algorithm, model, weights and parameters, or other underlying AI Technology or component of the Software, in whole or in part;

(f) access or use the Software or any AI Output to develop, train, or improve any AI Technology;

(g) use web scraping, web harvesting, web data extraction or any other method to extract data from the Software;

(h) remove, delete, alter, or obscure any trademarks or any copyright, trademark, patent, or other intellectual property or proprietary rights notices provided on or with the Software or Documentation, including any copy thereof;

(i) use the Software or Documentation to create or generate AI Output, or use AI Output in a manner, that Licensee knows or should know infringes, misappropriates, or otherwise violates any Intellectual Property Right or other right of any person, or that violates any applicable law, regulation, or rule;

(j) submit, enter, post, or otherwise transmit or process any personal information through the Software;

(k) rent, lease, lend, sell, sublicense, assign, distribute, publish, transfer, or otherwise make available the Software, or any features or functionality of the Software, to any Third Party for any reason, whether or not over a network or on a hosted basis, including in connection with the internet or any web hosting, wide area network (WAN), virtual private network (VPN), virtualization, time-sharing, service bureau, software as a service, cloud, or other technology or service;

(l) use the Software or Documentation for purposes of competitive analysis of the Software, the development of a competing software product or service, or any other purpose that is to the Licensor's commercial disadvantage.

5. Licensee Responsibilities.

(a) Licensee is responsible and liable for all uses of the Software and Documentation through access thereto provided by Licensee, directly or indirectly. Specifically, and without limiting the generality of the foregoing, Licensee is responsible and liable for all actions and failures to take required actions with respect to the Software and Documentation by its Authorized Users or by any other Person to whom Licensee or an Authorized User may provide access to or use of the Software or Documentation, whether such access or use is permitted by or in violation of this Agreement.

(b) The Software may not be used for unlawful, fraudulent, offensive, or obscene activity. Licensee shall comply with all terms and conditions of this Agreement, all applicable laws, rules, and regulations, and all guidelines, standards, requirements, and policies that may be posted on Licensor's website from time to time.

(c) Licensee is solely responsible for (i) evaluating (including by human review) AI Output for accuracy, completeness, and other factors relevant to Licensee's use before using, distributing, or relying on the AI Output and (ii) Licensee's decisions, actions, and omissions in reliance or based on the AI Output.

6. Compliance Measures. The Software may contain technological copy protection or other security features designed to prevent unauthorized use of the Software, including features to protect against any use of the Software that is prohibited under Section 4. Licensee shall not, and shall not attempt to, remove, disable, circumvent, or otherwise create or implement any workaround to, any such copy protection or security features.

7. Collection and Use of Information.

(a) Licensee acknowledges that Licensor may, directly or indirectly through the services of Third Parties, collect and store information regarding use of the Software and about equipment on which the Software is installed or through which it otherwise is accessed and used.

(b) Licensee agrees that the Licensor may use such information for any purpose related to any use of the Software by Licensee or on Licensee's equipment, including but not limited to:

(i) improving the performance of the Software or developing Updates; and

(ii) verifying Licensee's compliance with the terms of this Agreement and enforcing the Licensor's rights, including all Intellectual Property Rights in and to the Software.

8. Intellectual Property Rights.

(a) Licensee acknowledges and agrees that the Software and Documentation are provided under license, and not sold, to Licensee. Licensee does not acquire any ownership interest in the Software or Documentation under this Agreement, or any other rights thereto, other than to use the same in accordance with the license granted and subject to all terms, conditions, and restrictions under this Agreement. Licensor and its licensors and service providers reserve and shall retain their entire right, title, and interest in and to the Software and all Intellectual Property Rights arising out of or relating to the Software, except as expressly granted to the Licensee in this Agreement.

(b) Licensee shall safeguard all Software from infringement, misappropriation, theft, misuse, or unauthorized access. Licensee shall promptly notify Licensor if Licensee becomes aware of any infringement of the Licensor's Intellectual Property Rights in the Software and reasonably cooperate with Licensor in any legal action taken by Licensor to enforce its Intellectual Property Rights.

(c) Licensor acknowledges that, as between Licensor and Licensee, Licensee owns all right, title, and interest in and to its Licensee Data, subject to the license granted herein. Licensee hereby grants to Licensor a non-exclusive, royalty-free, worldwide license to (i) reproduce, distribute, and otherwise use and display the Licensee Data and process the Licensee Data as may be necessary for Licensor to enable Licensee's use of the Software and (ii) use, modify, and adapt AI Input and AI Output to train, develop, adapt, modify, enhance, or improve the Software and other products or services. Notwithstanding anything in this Agreement to the contrary, unless prohibited by applicable law, Licensor may delete Licensee Data at any time if Licensor determines that Licensee Data violates the terms of this Agreement or that deletion is necessary to comply with applicable law or regulation.

(d) If Licensee or any other Authorized User sends or transmits any communications or materials to Licensor by mail, email, telephone, or otherwise, suggesting or recommending changes to the Software, including without limitation, new features or functionality relating thereto, or any comments, questions, suggestions, or the like ("Feedback"), Licensor is free to use that Feedback. All Feedback is and will be treated as non-confidential.

9. Term and Termination.

(a) This Agreement and the license granted hereunder shall remain in effect until terminated as set forth herein (the "Term").

(b) Licensor may terminate this Agreement for any reason effective upon notice to Licensee.

(c) Licensee may terminate this Agreement by ceasing to use and destroying all copies of the Software and Documentation.

(d) Licensor may terminate this Agreement, effective immediately, if Licensee files, or has filed against it, a petition for voluntary or involuntary bankruptcy or pursuant to any other insolvency law, makes or seeks to make a general assignment for the benefit of its creditors or applies for, or consents to, the appointment of a trustee, receiver, or custodian for a substantial part of its property.

(e) Upon expiration or earlier termination of this Agreement, the license granted hereunder shall also terminate, and Licensee shall cease using and destroy all copies of the Software and Documentation.

(f) This Section 9(f), and Sections 3, 4, 7, 8, 10(b), 11, 12, 13, 14, 15, and 16, and any right, obligation, or required performance of the parties in this Agreement which, by its express terms or nature and context is intended to survive termination of this Agreement, will survive termination.

10. Warranty; Disclaimer.

(a) Warranty. Licensee represents, warrants, and covenants that (i) Licensee owns or otherwise has and will have all necessary rights, permissions, and consents in and relating to the AI Input so that, as received by Licensor and processed in accordance with this Agreement, it does not and will not infringe, misappropriate, or otherwise violate any Intellectual Property Rights, or any privacy or other rights of any third party or violate any applicable law, and (ii) no AI Input contains or will contain any personal information.

(b) THE SOFTWARE, DOCUMENTATION, AND AI OUTPUT ARE PROVIDED "AS IS" AND LICENSOR SPECIFICALLY DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE. LICENSOR SPECIFICALLY DISCLAIMS ALL IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT, AND ALL WARRANTIES ARISING FROM COURSE OF DEALING, USAGE, OR TRADE PRACTICE. LICENSOR MAKES NO WARRANTY OF ANY KIND THAT THE SOFTWARE, DOCUMENTATION, OR ANY PRODUCTS OR RESULTS OF THE USE THEREOF, INCLUDING ANY AI OUTPUTS, WILL MEET LICENSEE'S OR ANY OTHER PERSON'S OR ENTITY'S REQUIREMENTS, OPERATE WITHOUT INTERRUPTION, ACHIEVE ANY INTENDED RESULT, BE COMPATIBLE OR WORK WITH ANY SOFTWARE, SYSTEM, OR OTHER SERVICES, OR BE SECURE, ACCURATE, COMPLETE, FREE OF HARMFUL CODE, OR ERROR-FREE, OR THAT ANY ERRORS OR DEFECTS CAN OR WILL BE CORRECTED. LICENSEE ACKNOWLEDGES THAT, GIVEN THE NATURE OF THE SOFTWARE AND AI TECHNOLOGY, AI OUTPUT (I) MAY BE INACCURATE, MISLEADING, BIASED, OR OFFENSIVE, (II) MAY BE THE SAME AS OR SIMILAR TO OUTPUT THE SOFTWARE GENERATES FOR OTHERS, (III) MAY NOT QUALIFY FOR INTELLECTUAL PROPERTY PROTECTION, (IV) MAY BE SUBJECT TO THIRD PARTY TERMS, INCLUDING, AS APPLICABLE, OPEN SOURCE LICENSES, AND (V) DOES NOT NECESSARILY REFLECT, AND MAY BE INCONSISTENT WITH, LICENSOR'S AND THIRD PARTIES' VIEWS.

11. Indemnification. Licensee shall indemnify, hold harmless, and, at Licensor's option, defend Licensor and its officers, directors, employees, agents, affiliates, successors, and assigns from and against any and all claims, damages (whether direct, indirect, incidental, consequential, or otherwise), obligations, losses, liabilities, costs, debts, and expenses (including, but not limited to, reasonable legal fees) arising from or relating to any third-party claim: (i) that the AI Input, or processing or any other use thereof in accordance with this Agreement, infringes or misappropriates such third party's Intellectual Property Rights; or (ii) based on Licensee's or any Authorized User's negligence or willful misconduct or use of the Software or Documentation in violation of the terms of this Agreement or applicable laws; provided that Licensee may not settle any third-party claim against Licensor unless Licensor consents to such settlement, and further provided that Licensor will have the right, at its option, to defend itself against any such third-party claim or to participate in the defense thereof by counsel of its own choice.

12. Limitation of Liability. EXCEPT AS PROHIBITED BY LAW, IN NO EVENT WILL LICENSOR BE LIABLE UNDER OR IN CONNECTION WITH THIS AGREEMENT UNDER ANY LEGAL OR EQUITABLE THEORY, INCLUDING BREACH OF CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR OTHERWISE, FOR ANY: (a) CONSEQUENTIAL, INCIDENTAL, INDIRECT, EXEMPLARY, SPECIAL, ENHANCED, OR PUNITIVE DAMAGES; (b) INCREASED COSTS, DIMINUTION IN VALUE OR LOST BUSINESS, PRODUCTION, REVENUES, OR PROFITS; (c) LOSS OF GOODWILL OR REPUTATION; (d) USE, INABILITY TO USE, LOSS, INTERRUPTION, DELAY OR RECOVERY OF ANY DATA, OR BREACH OF DATA OR SYSTEM SECURITY; OR (e) COST OF REPLACEMENT GOODS OR SERVICES, IN EACH CASE REGARDLESS OF WHETHER LICENSOR WAS ADVISED OF THE POSSIBILITY OF SUCH LOSSES OR DAMAGES OR SUCH LOSSES OR DAMAGES WERE OTHERWISE FORESEEABLE. EXCEPT AS PROHIBITED BY LAW, IN NO EVENT WILL LICENSOR'S AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THIS AGREEMENT UNDER ANY LEGAL OR EQUITABLE THEORY, INCLUDING BREACH OF CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR OTHERWISE EXCEED ONE THOUSAND DOLLARS ($1,000.00).

13. Export Regulation. The Software may be subject to US export control laws, including the Export Control Reform Act and its associated regulations. Licensee shall not, directly or indirectly, export, re-export, or release the Software to, or make the Software accessible from, any jurisdiction or country to which export, re-export, or release is prohibited by law, rule, or regulation. Licensee shall comply with all applicable federal laws, regulations, and rules, and complete all required undertakings (including obtaining any necessary export license or other governmental approval), prior to exporting, re-exporting, releasing, or otherwise making the Software available outside the US.

14. US Government Rights. Each of the Documentation and the Software is a "commercial product" as that term is defined at 48 C.F.R. § 2.101, consisting of "commercial computer software" and "commercial computer software documentation" as such terms are used in 48 C.F.R. § 12.212. Accordingly, if Licensee is an agency of the US Government or any contractor therefor, Licensee only receives those rights with respect to the Software and Documentation as are granted to all other end users under license, in accordance with (a) 48 C.F.R. § 227.7201 through 48 C.F.R. § 227.7204, with respect to the Department of Defense and their contractors, or (b) 48 C.F.R. § 12.212, with respect to all other US Government licensees and their contractors.

15. Governing Law, Arbitration, and Class Action/Jury Trial Waiver.

(a) Governing Law. This Agreement will be governed by the internal substantive laws of the State of Delaware, without respect to its conflict of laws principles. The parties acknowledge that this Agreement evidence a transaction involving interstate commerce. Notwithstanding the preceding sentences with respect to the substantive law governing this Agreement, the Federal Arbitration Act (9 U.S.C. §§ 1-16) (as it may be amended, "FAA") governs the interpretation and enforcement of the Arbitration Agreement below and preempts all state laws (and laws of other jurisdictions) to the fullest extent permitted by applicable laws and regulations. If the FAA is found to not apply to any issue that arises from or relates to the Arbitration Agreement, then that issue will be resolved under and governed by the law of the U.S. state where Licensee lives (if applicable) or the jurisdiction mutually agreed upon in writing by the parties. The application of the United Nations Convention on Contracts for the International Sale of Goods is expressly excluded. Licensee agrees to submit to the exclusive personal jurisdiction of the federal and state courts located in Delaware for any actions for which Licensor retains the right to seek injunctive or other equitable relief in a court of competent jurisdiction to prevent the actual or threatened infringement, misappropriation, or violation of Licensor's data security or intellectual property rights, as set forth in the Arbitration Agreement below, including any provisional relief required to prevent irreparable harm. Licensee agrees that Delaware is the proper and exclusive forum for any appeals of an arbitration award, or for trial court proceedings in the event that the Arbitration Agreement below is found to be unenforceable. This Agreement was drafted in the English language and this English language version of this Agreement is the original, governing instrument of the understanding between Licensor and Licensee. In the event of any conflict between the English version of this Agreement and any translation, the English version will prevail.

(b) Arbitration Agreement.

(i) General. READ THIS SECTION CAREFULLY BECAUSE IT REQUIRES THE PARTIES TO ARBITRATE THEIR DISPUTES AND LIMITS THE MANNER IN WHICH LICENSEE CAN SEEK RELIEF FROM LICENSOR. This Arbitration Agreement applies to and governs any dispute, controversy, or claim between the parties that arises out of or relates to, directly or indirectly: (i) this Agreement, including the formation, existence, breach, termination, enforcement, interpretation, validity, and enforceability thereof; (ii) access to or use of the Software, including receipt of any advertising or marketing communications; (iii) any transactions through, by, or using the Software; or (iv) any other aspect of Licensee's relationship with Licensor, directly or indirectly (each, a "Claim," and, collectively, "Claims"). This Arbitration Agreement will apply, without limitation, to all Claims that arose or were asserted before or after Licensee's consent to this Agreement.

(ii) Opting Out of Arbitration Agreement. New Licensees can reject and opt out of this Arbitration Agreement within thirty (30) days of accepting the terms of this Agreement by emailing Licensor at gpd@psi.inc with their full, legal name and stating their intent to opt out of this Arbitration Agreement. Opting out of this Arbitration Agreement does not affect the binding nature of any other part of this Agreement, including the provisions regarding controlling law or the courts in which any disputes must be brought.

(iii) Dispute-Resolution Process. For any Claim, Licensee will first contact Licensor at gpd@psi.inc and attempt to resolve the Claim with Licensor informally. In the unlikely event that the parties have not been able to resolve a Claim after sixty (60) days, the parties each agree to resolve such Claim exclusively through binding arbitration by JAMS before a single arbitrator (the "Arbitrator"), under the Optional Expedited Arbitration Procedures then in effect for JAMS (the "Rules"), except as provided herein. JAMS may be contacted at www.jamsadr.com, where the Rules are available. In the event of any conflict between the Rules and this Arbitration Agreement, this Arbitration Agreement will control. The arbitration will be conducted in the U.S. county where Licensee lives (if applicable) or Sussex County, Delaware, unless the parties agree otherwise. If Licensee is using the Software for commercial purposes, each party will be responsible for paying any JAMS filing and administrative fees and Arbitrator fees in accordance with the Rules, and the award rendered by the Arbitrator will include costs of arbitration, reasonable attorneys' fees, and reasonable costs for expert and other witnesses. If Licensee is an individual using the Software for non-commercial purposes: (i) JAMS may require Licensee to pay a fee for the initiation of Licensee's case, unless Licensee applies for and successfully obtains a fee waiver from JAMS; (ii) the award rendered by the Arbitrator may include Licensee's costs of arbitration, Licensee's reasonable attorneys' fees, and Licensee's reasonable costs for expert and other witnesses; and (iii) Licensee may sue in a small claims court of competent jurisdiction without first engaging in arbitration, but this would not absolve Licensee of Licensee's commitment to engage in the informal dispute resolution process. Any judgment on the award rendered by the Arbitrator may be entered in any court of competent jurisdiction. The parties agree that the Arbitrator, and not any federal, state, or local court or agency, will have exclusive authority to resolve any disputes relating to the scope, interpretation, applicability, enforceability, or formation of this Arbitration Agreement, including any claim that all or any part of this Arbitration Agreement is void or voidable. The Arbitrator will also be responsible for determining all threshold arbitrability issues, including issues relating to whether this Agreement, or whether any provision of this Agreement, is unconscionable or illusory, and any defense to arbitration, including waiver, delay, laches, unconscionability, and/or estoppel.

(iv) Equitable Relief. NOTHING IN THIS ARBITRATION AGREEMENT WILL BE DEEMED AS: PREVENTING LICENSOR FROM SEEKING INJUNCTIVE OR OTHER EQUITABLE RELIEF FROM THE COURTS AS NECESSARY TO PREVENT THE ACTUAL OR THREATENED INFRINGEMENT, MISAPPROPRIATION, OR VIOLATION OF LICENSOR'S DATA SECURITY, CONFIDENTIAL INFORMATION, OR INTELLECTUAL PROPERTY RIGHTS; OR PREVENTING LICENSOR FROM ASSERTING CLAIMS IN A SMALL CLAIMS COURT, PROVIDED THAT LICENSEE'S CLAIMS QUALIFY AND SO LONG AS THE MATTER REMAINS IN SUCH COURT AND ADVANCES ON ONLY AN INDIVIDUAL (NON-CLASS, NON-COLLECTIVE, AND NON-REPRESENTATIVE) BASIS.

(v) Severability. If this Arbitration Agreement is found to be void, unenforceable, or unlawful, in whole or in part, the void, unenforceable, or unlawful provision, in whole or in part, will be severed. Severance of the void, unenforceable, or unlawful provision, in whole or in part, will have no impact on the remaining provisions of this Arbitration Agreement, which will remain in force, or on the parties' ability to compel arbitration of any remaining Claims on an individual basis pursuant to this Arbitration Agreement. Notwithstanding the foregoing, if the Class Action/Jury Trial Waiver below is found to be void, unenforceable, or unlawful, in whole or in part, because it would prevent Licensee from seeking public injunctive relief, then any dispute regarding the entitlement to such relief (and only that relief) must be severed from arbitration and may be litigated in a civil court of competent jurisdiction. All other claims for relief subject to arbitration under this Arbitration Agreement will be arbitrated under its terms, and the parties agree that litigation of any dispute regarding the entitlement to public injunctive relief will be stayed pending the outcome of any individual claims in arbitration.

(c) Class Action/Jury Trial Waiver. BY ENTERING INTO THIS AGREEMENT, THE PARTIES ARE EACH WAIVING THE RIGHT TO A TRIAL BY JURY OR TO BRING, JOIN, OR PARTICIPATE IN ANY PURPORTED CLASS ACTION, COLLECTIVE ACTION, PRIVATE ATTORNEY GENERAL ACTION, OR OTHER REPRESENTATIVE PROCEEDING OF ANY KIND AS A PLAINTIFF OR CLASS MEMBER. THE FOREGOING APPLIES TO ALL LICENSEES AND AUTHORIZED USERS (BOTH NATURAL PERSONS AND ENTITIES), REGARDLESS OF WHETHER THEY HAVE USED THE SOFTWARE FOR PERSONAL, COMMERCIAL, OR OTHER PURPOSES. THIS CLASS ACTION/JURY TRIAL WAIVER APPLIES TO CLASS ARBITRATION, AND, UNLESS THE PARTIES AGREE OTHERWISE, THE ARBITRATOR MAY NOT CONSOLIDATE MORE THAN ONE PERSON'S OR ENTITY'S CLAIMS. THE PARTIES AGREE THAT THE ARBITRATOR MAY AWARD RELIEF ONLY TO AN INDIVIDUAL CLAIMANT AND ONLY TO THE EXTENT NECESSARY TO PROVIDE RELIEF ON LICENSEE'S INDIVIDUAL CLAIM(S). ANY RELIEF AWARDED MAY NOT AFFECT OTHER USERS.

16. Miscellaneous.

(a) All notices, requests, consents, claims, demands, waivers, and other communications hereunder shall be in writing and shall be deemed to have been given: (i) when delivered by hand (with written confirmation of receipt); (ii) when received by the addressee if sent by a nationally recognized overnight courier (receipt requested); (iii) on the date sent by email (with confirmation of transmission) if sent during normal business hours of the recipient, and on the next business day if sent after normal business hours of the recipient; or (iv) on the third day after the date mailed, by certified or registered mail, return receipt requested, postage prepaid. Notwithstanding the foregoing, any notices to Licensor must be sent to gpd@psi.inc or Licensor's address available at https://www.psi.inc.

(b) This Agreement constitutes the sole and entire agreement between Licensee and Licensor with respect to the subject matter contained herein, and supersedes all prior and contemporaneous understandings, agreements, representations, and warranties, both written and oral, with respect to such subject matter.

(c) Licensee shall not assign or otherwise transfer any of its rights, or delegate or otherwise transfer any of its obligations or performance, under this Agreement, in each case whether voluntarily, involuntarily, by operation of law, or otherwise, without Licensor's prior written consent, which consent Licensor may give or withhold in its sole discretion. For purposes of the preceding sentence, and without limiting its generality, any merger, consolidation, or reorganization involving Licensee (regardless of whether Licensee is a surviving or disappearing entity) will be deemed to be a transfer of rights, obligations, or performance under this Agreement for which Licensor's prior written consent is required. No delegation or other transfer will relieve Licensee of any of its obligations or performance under this Agreement. Any purported assignment, delegation, or transfer in violation of this Section is void. Licensor may freely assign or otherwise transfer all or any of its rights, or delegate or otherwise transfer all or any of its obligations or performance, under this Agreement without Licensee's consent. This Agreement is binding upon and inures to the benefit of the parties hereto and their respective permitted successors and assigns.

(d) This Agreement is for the sole benefit of the parties hereto and their respective successors and permitted assigns and nothing herein, express or implied, is intended to or shall confer on any other Person any legal or equitable right, benefit, or remedy of any nature whatsoever under or by reason of this Agreement.

(e) Licensee acknowledges and agrees that Licensor has the right, in its sole discretion, to modify this Agreement from time to time, and that modified terms become effective on posting. Licensee will be notified of modifications through notifications or posts on Licensor's website, or direct email communication. Licensee is responsible for reviewing and becoming familiar with any modifications. Licensee's continued use of the Software after the effective date of the modifications will be deemed acceptance of the modified terms.

(f) Except as otherwise set forth in this Agreement, no failure to exercise, or delay in exercising, any right, remedy, power, or privilege arising from this Agreement shall operate or be construed as a waiver thereof; nor shall any single or partial exercise of any right, remedy, power, or privilege hereunder preclude any other or further exercise thereof or the exercise of any other right, remedy, power, or privilege.

(g) If any term or provision of this Agreement is invalid, illegal, or unenforceable in any jurisdiction, such invalidity, illegality, or unenforceability shall not affect any other term or provision of this Agreement or invalidate or render unenforceable such term or provision in any other jurisdiction.

(h) For purposes of this Agreement, (a) the words "include," "includes," and "including" shall be deemed to be followed by the words "without limitation"; (b) the word "or" is not exclusive; and (c) the words "herein," "hereof," "hereby," "hereto," and "hereunder" refer to this Agreement as a whole. Unless the context otherwise requires, references herein: (x) to Sections, Annexes, Schedules, and Exhibits refer to the Sections of, and Annexes, Schedules, and Exhibits attached to, this Agreement; (y) to an agreement, instrument, or other document means such agreement, instrument, or other document as amended, supplemented, and modified from time to time to the extent permitted by the provisions thereof and (z) to a statute means such statute as amended from time to time and includes any successor legislation thereto and any regulations promulgated thereunder. This Agreement shall be construed without regard to any presumption or rule requiring construction or interpretation against the party drafting an instrument or causing any instrument to be drafted.

(i) The headings in this Agreement are for reference only and do not affect the interpretation of this Agreement.
`

/** Human-readable Privacy Policy. Separate document per GDPR Art. 7(2) —
 *  privacy consent must be clearly distinguishable from contract
 *  acceptance. Two scroll + checkbox affordances client-side. */
export const PRIVACY_TEXT = `PSI PRIVACY NOTICE

Last Updated: April 27, 2026
This Privacy Notice explains how Physical Superintelligence PBC ("PSI") collects, uses, discloses, and otherwise processes personal data in connection with any specific product, service, or application that references or links to this Privacy Notice.
This Privacy Notice does not address our privacy practices relating to PSI job applicants, employees and other employment-related individuals, nor data that is not subject to applicable data protection laws (such as deidentified or publicly available information in certain jurisdictions). This Privacy Notice is also not a contract and does not create any legal rights or obligations not otherwise provided by law.

Our Collection and Use of Personal Data

The categories of personal data we collect depend on how you interact with us and our services. For example, you may provide us your personal data directly when you sign up for our mailing list, obtain one of our products or services, or otherwise contact us or interact with us.
We also collect personal data automatically when you interact with our websites and other services and may also collect personal data from other sources and third parties.

Personal Data Provided by Individuals

We collect the following categories of personal data individuals provide us:
Contact Information, including first and last name, phone number, email address, and communication preferences. We use this information primarily to fulfill your request or transaction, to communicate with you directly, and to send you communications in accordance with your preferences.
Account Information, including first and last name, email address, phone number, account credentials, and the products or services you are interested in, obtained, or have otherwise used. We use this information primarily to administer your account, provide you with our products and services, communicate with you regarding your account and your use of our products and services, and for customer support purposes.
Customer Content, including any files, documents, audio, videos, images, data, or communications you choose to input, upload, or transmit to our products and services. We use this content primarily to provide you with our products and services, to facilitate your requests, and to improve our products and services (including by training or fine-tuning our and our third-party providers' artificial intelligence and machine learning models).
Feedback and Support Information, including the contents of custom messages sent through the forms, chat platforms, email addresses, or other contact information we make available to customers, as well as recordings of calls with us, where permitted by law (including through the use of automated or artificial intelligence tools provided by us or our third-party providers). We use this information primarily to investigate and respond to your inquiries, to communicate with you via email, phone, text message or social media, and to improve our products and services.

Personal Data Automatically Collected

We, and our third-party partners, automatically collect information you provide to us and information about how you access and use our products and services when you engage with us. We typically collect this information through the use of a variety of our own and our third-party partners' automatic data collection technologies, including (i) cookies or small data files that are stored on an individual's computer and (ii) other, related technologies, such as web beacons, pixels, embedded scripts, mobile SDKs, location-identifying technologies and logging technologies. Information we collect automatically about you may be combined with other personal data we collect directly from you or receive from other sources.
We, and our third-party partners, use automatic data collection technologies to automatically collect the following data when you use our services or otherwise engage with us:
Information About Your Device and Network, including the device type, manufacturer, and model, operating system, IP address, browser type, Internet service provider, and unique identifiers associated with you, your device, or your network (including, for example, a persistent device identifier). We employ third-party technologies designed to allow us to recognize when two or more devices are likely being used by the same individual and may leverage these technologies (where permitted by law) to link information collected from different devices.
Information About the Way Individuals Use Our Services and Interact With Us, including the site from which you came, the site to which you are going when you leave our services, how frequently you access our services, whether you open emails or click the links contained in emails, whether you access our services from multiple devices, and other browsing behavior and actions you take on our services (such as the pages you visit, the content you view, the communications you have through our services, and the content and links you interact with).
Information About Your Location, including general geographic location that we or our third-party providers may derive from your IP address.
All of the information collected automatically through these tools allows us to improve your experience. For example, we may use this information to enhance and personalize your user experience, to monitor and improve our products and services, to offer communications features, and to improve the effectiveness of our products, services, offers, communications and customer service.  We may also use this information to:  (a) remember information so that you will not have to re-enter it during your visit or the next time you visit the site; (b) provide custom, personalized content and information; (c) identify you across multiple devices; (d) provide and monitor the effectiveness of our services; (e) monitor aggregate metrics such as total number of visitors, traffic, usage, and demographic patterns on our website; (f) diagnose or fix technology problems; and (g) otherwise to plan for and enhance our products and services.
For information about the choices you may have in relation to our use of automatic data collection technologies, please refer to the Your Privacy Choices section below.

Personal Data from Other Sources and Third Parties

We may receive the same categories of personal data as described above from the following sources and other parties:
Other Customers: We may receive your personal data from our other customers. For example, a customer may provide us with your contact information as a part of a referral.
Service Providers: Our service providers that perform services on our behalf, such as analytics and certain marketing providers, collect personal data and often share some or all of this information with us.
Other Sources: We may also collect personal data about you from other sources, including through transactions such as mergers and acquisitions.
Inferences: We may generate inferences or predictions about you and your interests and preferences based on the other personal data we collect and the interactions we have with you.

Additional Uses of Personal Data

In addition to the primary purposes for using personal data described above, we may also use personal data we collect to:
Fulfill or meet the reason the information was provided, such as to fulfill our contractual obligations, to facilitate your access to our products and services, or to deliver the products and services requested;
Manage our organization and its day-to-day operations;
Communicate with you, including via email, text message, social media and/or telephone calls;
Facilitate the relationship we have with you and, where applicable, the company you represent;
Request you provide us feedback about our product and service offerings;
Address inquiries or complaints made by or about an individual in connection with our products or services;
Create and maintain accounts for our users;
Verify your identity and entitlement to our products and services;
Administer, improve, and personalize our products and services, including by recognizing you and remembering your information when you return to our products and services;
Develop, operate, improve, maintain, protect, and provide the features and functionality of our products and services (including by training or fine-tuning our and our third-party providers' artificial intelligence and machine learning models);
Identify and analyze how you use our products and services;
Create aggregated or de-identified information that cannot reasonably be used to identify you, which information we may use for purposes outside the scope of this Privacy Notice;
Conduct research and analytics on our user base and our products and services, including to better understand the demographics of our users;
Improve and customize our products and services to address the needs and interests of our user base and other individuals we interact with;
Test, enhance, update, and monitor the products and services, or diagnose or fix technology problems;
Help maintain and enhance the safety, security, and integrity of our property, products, services, technology, assets, and business;
Defend, protect, or enforce our rights or applicable contracts and agreements (including our Terms of Use), as well as to resolve disputes, to carry out our obligations and enforce our rights, and to protect our business interests and the interests and rights of third parties;
Detect, prevent, investigate, or provide notice of security incidents or other malicious, deceptive, fraudulent, or illegal activity and protect the rights and property of PSI and others;
Facilitate business transactions and reorganizations impacting the structure of our business;
Comply with contractual and legal obligations and requirements;
Fulfill any other purpose for which you provide your personal data, or for which you have otherwise consented.
As noted above, we may use your personal data to improve our services and train or fine-tune the artificial intelligence and machine learning models that power our platform and services.

Our Disclosure of Personal Data

We disclose or otherwise make available personal data in the following ways:
To Service Providers: We engage other third parties to perform certain services on our behalf in connection with the uses of personal data described in the sections above. Depending on the applicable services, these service providers may process personal data on our behalf or have access to personal data while performing services on our behalf.
In Connection with a Business Transaction or Reorganization: We may take part in or be involved with a business transaction or reorganization, such as a merger, acquisition, joint venture, or financing or sale of company assets. We may disclose, transfer, or assign personal data to a third party during negotiation of, in connection with, or as an asset in such a business transaction or reorganization. Also, in the unlikely event of our bankruptcy, receivership, or insolvency, your personal data may be disclosed, transferred, or assigned to third parties in connection with the proceedings or disposition of our assets.
To Facilitate Legal Obligations and Rights: We may disclose personal data to third parties, such as legal advisors and law enforcement:
in connection with the establishment, exercise, or defense of legal claims;
to comply with laws or to respond to lawful requests and legal process;
to protect our rights and property and the rights and property of our agents, customers, and others, including to enforce our agreements, policies, and terms of use;
to detect, suppress, or prevent fraud;
to reduce credit risk and collect debts owed to us;
to protect the health and safety of us, our customers, or any person; or
as otherwise required by applicable law.
With Your Consent or Direction: We may disclose your personal data to certain other third parties or publicly with your consent or direction. For example, with your permission, we may post your testimonial on our websites.

Your Privacy Choices

Email Communication Preferences

You can stop receiving promotional email communications from us by clicking on the "unsubscribe" link provided in any of our email communications. Please note you cannot opt-out of service-related email communications (such as, account verification, transaction confirmation, or service update emails).

Withdrawing Your Consent

Where we have your consent for the processing of your personal data, you may withdraw your consent by following the instructions provided when your consent was requested or by contacting us as set forth in the Contact Us section below.

Automatic Data Collection Preferences

You may be able to utilize third-party tools and features to restrict our use of automatic data collection technologies. For example, (i) most browsers allow you to change browser settings to limit automatic data collection technologies on websites, (ii) most email providers allow you to prevent the automatic downloading of images in emails that may contain automatic data collection technologies, and (iii) many devices allow you to change your device settings to limit automatic data collection technologies for device applications. Please note that blocking automatic data collection technologies through third-party tools and features may negatively impact your experience using our services, as some features and offerings may not work properly or at all. Depending on the third-party tool or feature you use, you may not be able to block all automatic data collection technologies or you may need to update your preferences on multiple devices or browsers. We do not have any control over these third-party tools and features and are not responsible if they do not function as intended.
Children's Personal Data
Our services are not directed to, and we do not intend to, or knowingly, collect or solicit personal data from children under the age of 13. If an individual is under the age of 13, they should not use our services or otherwise provide us with any personal data either directly or by other means. If a child under the age of 13 has provided personal data to us, we encourage the child's parent or guardian to contact us to request that we remove the personal data from our systems. If we learn that any personal data we collect has been provided by a child under the age of 13, we will promptly delete that personal data.

Security of Personal Data

We have implemented reasonable physical, technical, and organizational safeguards that are designed to protect your personal data. In addition, we take steps designed to ensure any third party with whom we share personal data provides a similar level of protection. However, despite these controls, we cannot completely ensure or warrant the security of your personal data.

Third-Party Websites and Services

Our websites and other services may include links to or redirect you to third-party websites, plug-ins, applications, or other services. Third-party websites and other services may also reference or link to our websites and services. This Privacy Notice does not apply to any personal data practices of these third-party websites, plug-ins, applications, or other services. To learn about these third parties' personal data practices, please visit their respective privacy notices.

Updates to This Privacy Notice

We may update this Privacy Notice from time to time. When we make changes to this Privacy Notice, we will change the date at the beginning of this Privacy Notice. If we make material changes to this Privacy Notice, we will notify individuals by email to their registered email address, by prominent posting on this website or our other platforms, or through other appropriate communication channels. All changes shall be effective from the date of publication unless otherwise provided.

Contact Us

If you have any questions or requests in connection with this Privacy Notice or other privacy-related matters, please contact us at: ted@psi.inc.
`
